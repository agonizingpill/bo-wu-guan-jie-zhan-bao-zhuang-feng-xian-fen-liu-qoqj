import {field, fileIndex, heading, recordHeader, stamp} from '../components.js';
import {bookingOutcomes, bookingRules, optionStates, windowStates} from '../constants.js';
import {clock, dateTime, escape as e, percent, toLocal} from '../format.js';

function board(windows, day) {
  const midnight = Date.parse(`${day}T00:00:00+08:00`);
  const entries = windows.filter((item) => Date.parse(item.begins_at) < midnight + 86400000 && Date.parse(item.ends_at) > midnight);
  if (!entries.length) return '<p class="empty">当天没有布置或运输窗口。可切换日期查看其他安排。</p>';
  const ranges = entries.map((item) => [Math.max(0, (Date.parse(item.begins_at) - midnight) / 60000),
    Math.min(1440, (Date.parse(item.ends_at) - midnight) / 60000)]);
  const start = Math.floor(Math.min(660, ...ranges.map(([from]) => from)) / 60) * 60;
  const end = Math.ceil(Math.max(1020, ...ranges.map(([, till]) => till)) / 60) * 60;
  const step = Math.ceil((end - start) / 420) * 60;
  const ticks = Array.from({length: Math.floor((end - start) / step) + 1}, (_, i) => start + i * step);
  return `<div class="board-grid"><div class="axis">${ticks.map((tick) => `<span style="left:${100 * (tick - start) / (end - start)}%">${tick / 60}:00</span>`).join('')}</div>
    ${entries.map((item, index) => {
      const [from, till] = ranges[index];
      const risk = item.option?.risk === 'high' ? '（高风险）' : item.option?.risk === 'low' ? '（低风险）' : '';
      return `<div class="board-row"><div><strong>${e(item.gallery)}</strong><small>${e(item.label)}${risk}</small></div>
        <div class="track"><span class="span" data-state="${item.status}" title="${e(windowStates[item.status])} ${clock(item.begins_at)}–${clock(item.ends_at)}"
          style="left:${100 * (from - start) / (end - start)}%;width:${100 * (till - from) / (end - start)}%"></span></div>
        <span class="hours mono">${clock(item.begins_at)}–${clock(item.ends_at)}</span></div>`;
    }).join('')}</div><p class="legend"><span>展厅布置</span><span>确认／已派车</span><span>有冲突</span></p>`;
}

function setupForm() {
  return `<dialog id="setup"><form data-action="setup"><h2>登记展厅布置</h2><div class="form-grid">
    ${field('展厅', 'gallery')}${field('布置作业', 'label')}${field('开始', 'begins_at', {type: 'datetime-local'})}
    ${field('结束', 'ends_at', {type: 'datetime-local'})}</div>
    <div class="form-actions"><button type="button" class="subtle" data-close-dialog>取消</button><button>保存布置</button></div></form></dialog>`;
}

function leg(index) {
  return `<fieldset class="offer-leg"><legend>时段 ${index + 1}${index === 0 ? '' : '（可选）'}</legend><div class="form-grid">
    ${field('车辆标识', `vehicle-${index}`, {placeholder: '沪A·藏照01', required: false})}
    ${field('预计最高湿度（% RH）', `rh-${index}`, {type: 'number', min: 0, max: 100, value: 55, required: false})}
    ${field('开始（上海时间）', `begins-${index}`, {type: 'datetime-local', required: false})}
    ${field('结束（上海时间）', `ends-${index}`, {type: 'datetime-local', required: false})}
    ${field('转运次数', `transfers-${index}`, {type: 'number', min: 0, max: 8, value: 1, required: false})}</div></fieldset>`;
}

function optionsForm(record) {
  return `<form data-action="options"><div class="offer-legs">${[0, 1, 2].map(leg).join('')}</div>
    <div class="form-actions"><span>至少填写一个时段；按湿度与转运次数逐项评分后择优订位。</span><button>评分并择时订位</button></div></form>`;
}

function optionsSheet(record) {
  const options = record.options ?? [];
  if (!options.length) return '<p class="empty">尚无备选时段。承运方给出时段后，可在下方录入并评分。</p>';
  const chosen = record.booking?.chosen_option_id;
  return `<div class="option-scroll"><table class="option-table"><thead><tr><th>时段</th><th>车辆</th><th>湿度 / 转运</th><th>风险</th><th>状态</th><th>依据</th></tr></thead><tbody>
    ${options.map((option) => `<tr${option.id === chosen ? ' class="chosen"' : ''}>
      <td class="mono">${clock(option.begins_at)}–${clock(option.ends_at)}<br><small>${dateTime(option.begins_at).slice(0, 10)}</small></td>
      <td>${e(option.vehicle)}</td>
      <td>${option.expected_rh}% / ${option.transfers} 次</td>
      <td>${stamp(option.risk, {low: '低风险', high: '高风险'})}<br><small class="mono">${percent(option.probability)}</small></td>
      <td>${stamp(option.status, optionStates)}</td>
      <td><small>${e(option.conflict_reason ?? (option.id === chosen ? '按规则订为窗口' : '无冲突，未选中'))}</small></td></tr>`).join('')}
    </tbody></table></div>
    ${record.booking ? `<p class="basis-line"><strong>${bookingOutcomes[record.booking.outcome]}</strong> · ${bookingRules[record.booking.rule]}
      <span class="mono">指纹 ${e(record.booking.digest.slice(0, 12))}</span> <small>${dateTime(record.booking.recorded_at)} 入档</small></p>` : ''}`;
}

export function transitPage({loans, record, staff, schedule, scheduleDay}) {
  const supervisor = staff.role === 'supervisor';
  const canReserve = staff.role === 'operator' && record?.status !== 'dispatched';
  const current = record?.transit;
  const day = scheduleDay || dateTime(current?.begins_at ?? schedule[0]?.begins_at).slice(0, 10).replace('—', '');
  return `${heading('运输窗口', '借品装卸、备选时段与展厅布置的时间台账', supervisor ? '<button data-open-dialog="setup">登记展厅布置</button>' : '')}
    <div class="workbench">${fileIndex(loans, record, 'transit')}
      <article class="dossier">${record ? recordHeader(record) : ''}
        <section class="timeboard"><div class="section-line"><h3>展厅与车辆占用</h3><label>查看日期 <input type="date" id="schedule-day" value="${e(day)}"></label></div>
        ${board(schedule, day)}</section>
        ${record ? `<section class="dispatch-panel"><h3>本批运输单 ${current ? stamp(current.status, windowStates) : ''}</h3>
          ${current ? `<p>${e(current.vehicle)} · ${dateTime(current.begins_at)} 至 ${clock(current.ends_at)}</p>` : '<p class="empty">尚未提交窗口。</p>'}
          ${record.dispatch_issue ? `<p class="${record.status === 'dispatched' ? 'muted' : 'alert'}">${e(record.dispatch_issue)}</p>` : '<p class="success-line">封签、窗口与风险放行均已确认。</p>'}
          ${canReserve ? `<form data-action="transit"><div class="form-grid transit-fields">
            ${field('车辆标识', 'vehicle', {value: current?.vehicle, placeholder: '沪A·藏照01'})}
            ${field('开始（上海时间）', 'begins_at', {type: 'datetime-local', value: toLocal(current?.begins_at)})}
            ${field('结束（上海时间）', 'ends_at', {type: 'datetime-local', value: toLocal(current?.ends_at)})}</div>
            <div class="form-actions"><button>${current ? '改排窗口' : '登记窗口'}</button>
            <button type="button" class="subtle" data-dispatch>确认派车</button></div></form>` : ''}</section>
          <section class="options-panel"><div class="section-line"><h3>备选时段与订位依据</h3>${record.booking ? stamp(record.booking.outcome, bookingOutcomes) : ''}</div>
            ${optionsSheet(record)}
            ${canReserve && !record.triage ? optionsForm(record) : ''}</section>` : ''}</article></div>
    ${supervisor ? setupForm() : ''}`;
}
