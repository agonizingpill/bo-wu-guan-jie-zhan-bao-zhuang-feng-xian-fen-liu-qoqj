import hashlib
import json
from datetime import timezone

from fastapi import HTTPException
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from .loans import active_loan, change_status, dispatch_issue, dossier, option_history
from .schemas import LoanStatus
from .scoring import score
from .storage import audit

ALL_CONFLICT = '所选备选时段均与其他布置或运输窗口冲突，请等承运方改期'


def lock_schedule(db):
    db.execute('SELECT pg_advisory_xact_lock(66002)')


def schedule(db):
    return db.execute('''SELECT w.*, l.accession, to_jsonb(o) AS option FROM transit_window w
                        LEFT JOIN exhibit_loan l ON l.id=w.loan_id
                        LEFT JOIN transit_option o ON o.id=w.option_id
                        WHERE w.status <> 'superseded' ORDER BY w.begins_at,w.id''').fetchall()


def basis(db, loan_id):
    if not db.execute('SELECT 1 FROM exhibit_loan WHERE id=%s', (loan_id,)).fetchone():
        raise HTTPException(404, '未找到借展批次')
    options, booking = option_history(db, loan_id)
    return {'options': options, 'booking': booking}


def block_gallery(db, data, actor):
    lock_schedule(db)
    if db.execute('''SELECT 1 FROM transit_window WHERE gallery=%s AND status IN ('booked','dispatched')
                     AND begins_at < %s AND ends_at > %s LIMIT 1''',
                  (data.gallery, data.ends_at, data.begins_at)).fetchone():
        raise HTTPException(409, '与已确认的运输窗口重叠，请调整布置时间')
    try:
        row = db.execute('''INSERT INTO transit_window (gallery,label,begins_at,ends_at,status,recorded_by)
                        VALUES (%s,%s,%s,%s,'setup',%s) RETURNING *''',
                         (data.gallery, data.label, data.begins_at, data.ends_at, actor)).fetchone()
    except UniqueViolation as exc:
        raise HTTPException(409, '该展厅已登记相同布置窗口') from exc
    audit(db, None, actor, 'gallery_setup', window_id=row['id'], gallery=data.gallery, label=data.label)
    return row


def reserve(db, loan_id, data, actor):
    loan = active_loan(db, loan_id)
    if data.ends_at > loan['must_arrive']:
        raise HTTPException(409, '运输窗口不能越过借展到馆期限')
    lock_schedule(db)
    overlap = db.execute('''SELECT id,status,label,gallery FROM transit_window
        WHERE loan_id IS DISTINCT FROM %s AND begins_at < %s AND ends_at > %s
          AND ((status='setup' AND gallery=%s) OR (status IN ('booked','dispatched') AND (vehicle=%s OR gallery=%s)))
        ORDER BY CASE WHEN status='setup' THEN 0 ELSE 1 END,id LIMIT 1''',
        (loan_id, data.ends_at, data.begins_at, loan['gallery'], data.vehicle, loan['gallery'])).fetchone()
    if overlap:
        reason = (f"{overlap['gallery']}正在布置（{overlap['label']}），请改期" if overlap['status'] == 'setup'
                  else '同一展厅或车辆已有运输窗口，请改期')
    else:
        reason = None
    db.execute("UPDATE transit_option SET status='superseded' WHERE loan_id=%s AND status IN ('offered','booked')",
               (loan_id,))
    previous = db.execute('''UPDATE transit_window SET status='superseded' WHERE loan_id=%s
                          AND status IN ('booked','conflict') RETURNING id''', (loan_id,)).fetchone()
    row = db.execute('''INSERT INTO transit_window (loan_id,gallery,vehicle,label,begins_at,ends_at,status,conflict_reason,recorded_by)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id''',
                     (loan_id, loan['gallery'], data.vehicle, loan['accession'], data.begins_at, data.ends_at,
                      'conflict' if overlap else 'booked', reason, actor)).fetchone()
    audit(db, loan_id, actor, 'window_conflict' if overlap else 'window_reserved', window_id=row['id'],
          previous_window=previous['id'] if previous else None, reason=reason,
          conflict_window=overlap['id'] if overlap else None)
    return dossier(db, loan_id)


def offers_digest(offers):
    payload = [{'vehicle': offer.vehicle,
                'begins_at': offer.begins_at.astimezone(timezone.utc).isoformat(),
                'ends_at': offer.ends_at.astimezone(timezone.utc).isoformat(),
                'expected_rh': offer.expected_rh,
                'transfers': offer.transfers} for offer in offers]
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def option_rank(option):
    return (option['ends_at'], option['begins_at'], option['ordinal'])


def clash(db, loan, option):
    if option['ends_at'] > loan['must_arrive']:
        return '窗口结束晚于借展到馆期限'
    row = db.execute('''SELECT id,status,label,gallery FROM transit_window
        WHERE loan_id IS DISTINCT FROM %s AND begins_at < %s AND ends_at > %s
          AND ((status='setup' AND gallery=%s) OR (status IN ('booked','dispatched') AND (vehicle=%s OR gallery=%s)))
        ORDER BY CASE WHEN status='setup' THEN 0 ELSE 1 END,id LIMIT 1''',
        (loan['id'], option['ends_at'], option['begins_at'], loan['gallery'], option['vehicle'],
         loan['gallery'])).fetchone()
    if not row:
        return None
    return (f"{row['gallery']}正在布置（{row['label']}），请改期" if row['status'] == 'setup'
            else '同一展厅或车辆已有运输窗口，请改期')


def record_offers(db, loan_id, data, actor):
    loan = active_loan(db, loan_id)
    digest = offers_digest(data.options)
    lock_schedule(db)
    if db.execute('SELECT 1 FROM transit_option WHERE loan_id=%s AND batch_digest=%s LIMIT 1',
                  (loan_id, digest)).fetchone():
        return dossier(db, loan_id)
    check = db.execute('SELECT * FROM crate_check WHERE loan_id=%s', (loan_id,)).fetchone()
    if not check:
        raise HTTPException(409, '请先完成包装检查，再按材质和包装给备选时段评分')
    if db.execute('SELECT 1 FROM triage_case WHERE loan_id=%s', (loan_id,)).fetchone():
        raise HTTPException(409, '该批次已送评，不能再录入备选；有新时段请联系文保主管复核')
    db.execute("UPDATE transit_option SET status='superseded' WHERE loan_id=%s AND status IN ('offered','booked')",
               (loan_id,))
    previous = db.execute('''UPDATE transit_window SET status='superseded' WHERE loan_id=%s
                          AND status IN ('booked','conflict') RETURNING id''', (loan_id,)).fetchone()
    candidates = []
    for ordinal, offer in enumerate(data.options):
        probability, risk, evidence = score({'material': check['material'], 'packing': check['packing'],
                                             'route_type': check['route_type'], 'max_rh': offer.expected_rh,
                                             'transfers': offer.transfers})
        option = {'ordinal': ordinal, 'vehicle': offer.vehicle, 'begins_at': offer.begins_at,
                  'ends_at': offer.ends_at, 'expected_rh': offer.expected_rh, 'transfers': offer.transfers}
        option['conflict_reason'] = clash(db, loan, option)
        option['risk'], option['probability'], option['evidence'] = risk, probability, evidence
        candidates.append(option)
    for option in candidates:
        option['id'] = db.execute('''INSERT INTO transit_option
            (loan_id,ordinal,vehicle,begins_at,ends_at,expected_rh,transfers,status,risk,probability,
             conflict_reason,batch_digest,recorded_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,'offered',%s,%s,%s,%s,%s) RETURNING id''',
            (loan_id, option['ordinal'], option['vehicle'], option['begins_at'], option['ends_at'],
             option['expected_rh'], option['transfers'], option['risk'], option['probability'],
             option['conflict_reason'], digest, actor)).fetchone()['id']
    audit(db, loan_id, actor, 'transit_options_recorded', digest=digest, offer_count=len(candidates),
          offers=[{'ordinal': option['ordinal'], 'vehicle': option['vehicle'],
                   'begins_at': option['begins_at'].isoformat(), 'ends_at': option['ends_at'].isoformat(),
                   'expected_rh': option['expected_rh'], 'transfers': option['transfers'],
                   'risk': option['risk'], 'probability': round(option['probability'], 6),
                   'conflict': option['conflict_reason']} for option in candidates])
    free = [option for option in candidates if not option['conflict_reason']]
    low = sorted((option for option in free if option['risk'] == 'low'), key=option_rank)
    high = sorted((option for option in free if option['risk'] == 'high'), key=option_rank)
    chosen, rule = ((low[0], 'low_risk_earliest') if low else
                    (high[0], 'high_risk_earliest') if high else (None, 'none_conflict_free'))
    if not chosen:
        earliest = min(candidates, key=option_rank)
        window = db.execute('''INSERT INTO transit_window
            (loan_id,gallery,vehicle,label,begins_at,ends_at,status,conflict_reason,recorded_by,option_id)
            VALUES (%s,%s,%s,%s,%s,%s,'conflict',%s,%s,%s) RETURNING id''',
            (loan_id, loan['gallery'], earliest['vehicle'], loan['accession'], earliest['begins_at'],
             earliest['ends_at'], ALL_CONFLICT, actor, earliest['id'])).fetchone()
        audit(db, loan_id, actor, 'window_conflict', window_id=window['id'],
              previous_window=previous['id'] if previous else None, reason=ALL_CONFLICT,
              option_id=earliest['id'], digest=digest)
        audit(db, loan_id, actor, 'options_all_conflict', digest=digest, option_id=earliest['id'])
        return dossier(db, loan_id)
    window = db.execute('''INSERT INTO transit_window
        (loan_id,gallery,vehicle,label,begins_at,ends_at,status,recorded_by,option_id)
        VALUES (%s,%s,%s,%s,%s,%s,'booked',%s,%s) RETURNING id''',
        (loan_id, loan['gallery'], chosen['vehicle'], loan['accession'], chosen['begins_at'],
         chosen['ends_at'], actor, chosen['id'])).fetchone()
    db.execute("UPDATE transit_option SET status='booked' WHERE id=%s", (chosen['id'],))
    audit(db, loan_id, actor, 'window_reserved', window_id=window['id'],
          previous_window=previous['id'] if previous else None, option_id=chosen['id'], rule=rule,
          risk=chosen['risk'], probability=chosen['probability'],
          expected_rh=chosen['expected_rh'], transfers=chosen['transfers'])
    snapshot = {'material': check['material'], 'packing': check['packing'], 'route_type': check['route_type'],
                'max_rh': chosen['expected_rh'], 'transfers': chosen['transfers']}
    case_id = db.execute('''INSERT INTO triage_case
        (loan_id,status,input_snapshot,probability,risk,evidence,attempts,requested_by,computed_at)
        VALUES (%s,'scored',%s,%s,%s,%s,1,%s,now()) RETURNING id''',
        (loan_id, Jsonb(snapshot), chosen['probability'], chosen['risk'], Jsonb(chosen['evidence']),
         actor)).fetchone()['id']
    audit(db, loan_id, actor, 'triage_scored', case_id=case_id, risk=chosen['risk'],
          probability=chosen['probability'], source='transit_option', option_id=chosen['id'])
    if chosen['risk'] == 'high':
        db.execute("INSERT INTO unpack_review (case_id,status) VALUES (%s,'awaiting_witness')", (case_id,))
        audit(db, loan_id, actor, 'review_opened', case_id=case_id, option_id=chosen['id'])
        change_status(db, loan_id, LoanStatus.REVIEW_REQUIRED)
    else:
        change_status(db, loan_id, LoanStatus.READY)
    return dossier(db, loan_id)


def dispatch(db, loan_id, actor):
    active_loan(db, loan_id)
    lock_schedule(db)
    record = dossier(db, loan_id)
    reason = dispatch_issue(record)
    if reason:
        audit(db, loan_id, actor, 'dispatch_blocked', reason=reason)
        return record, reason
    window = record['transit']
    db.execute("UPDATE transit_window SET status='dispatched' WHERE id=%s", (window['id'],))
    change_status(db, loan_id, LoanStatus.DISPATCHED)
    audit(db, loan_id, actor, 'dispatched', window_id=window['id'], vehicle=window['vehicle'],
          seal=record['crate']['seal_code'])
    return dossier(db, loan_id), None
