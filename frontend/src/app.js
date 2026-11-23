import {api} from './api.js';
import {bookingRules, roles, sections} from './constants.js';
import {field} from './components.js';
import {escape as e, fromLocal, toLocal} from './format.js';
import {archivePage} from './pages/archive.js';
import {transitPage} from './pages/transit.js';
import {triagePage} from './pages/triage.js';
import {reviewPage} from './pages/review.js';
import {saveSession, store} from './store.js';

const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const renderers = {archive: archivePage, transit: transitPage, triage: triagePage, review: reviewPage};
let generation = 0;
let poll, noticeTimer;

function currentRoute() {
  const [page, id] = location.hash.slice(1).split('/');
  return {page: Object.hasOwn(renderers, page) ? page : 'archive', id: Number(id)};
}

function tell(message, failed = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.toggle('failure', failed);
  notice.hidden = false;
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 6100);
}

function loginPage() {
  app.innerHTML = `<main class="login-layout"><section class="login-cover" aria-label="栖川市博物馆">
    <p class="institution">栖川市博物馆 <span>藏品登记室</span></p>
    <div class="cover-title"><h1>借展包装<br>档案</h1><p>展品从出借方交接到车队前，<br>在这里核对包装、运输窗口和放行签字。</p></div>
    <div class="cover-label"><span>借展作业台账</span><span class="mono">REGISTRAR / CRATE LOG</span></div></section>
    <section class="login-form"><h2>馆员登录</h2><p>使用岗位账号调阅借展档案。</p>
      <form data-action="login">${field('账号', 'username', {placeholder: '输入岗位账号'})}
        ${field('密码', 'password', {type: 'password', placeholder: '输入密码'})}<button>进入档案</button></form>
      <div class="login-roles"><p>演示岗位</p>${Object.entries(roles).map(([id, label]) =>
        `<button type="button" class="subtle" data-demo="${id}">${label}</button>`).join('')}</div>
    </section></main>`;
}

function shell(page, content) {
  app.innerHTML = `<header class="topbar"><div class="top-inner">
    <a class="brand" href="#archive"><span class="brand-seal" aria-hidden="true">栖</span><div><strong>借展包装档案</strong><small>栖川市博物馆 · 藏品登记室</small></div></a>
    <nav aria-label="工作区">${Object.entries(sections).map(([name, [label]]) =>
      `<a href="#${name}${store.record ? `/${store.record.id}` : ''}" ${name === page ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div class="user"><span>${e(store.staff.display_name)} <small>${e(roles[store.staff.role])}</small></span>
    <button type="button" class="text-button" data-logout>退出</button></div></div></header>
    <main class="main" id="workspace">${content}</main>`;
}

const authed = (path, options = {}) => api(path, {...options, token: store.token});

async function render() {
  const ticket = ++generation;
  clearTimeout(poll);
  if (!store.staff) { loginPage(); return; }
  const {page, id} = currentRoute();
  try {
    const [loans, schedule] = await Promise.all([authed('/loans'), page === 'transit' ? authed('/schedule') : []]);
    if (ticket !== generation) return;
    const selected = loans.find((item) => item.id === id) ?? loans.find((item) => item.review) ?? loans[0];
    const record = selected ? await authed(`/loans/${selected.id}`) : null;
    if (ticket !== generation) return;
    Object.assign(store, {loans, record, schedule});
    shell(page, renderers[page](store));
    if (record?.triage?.status === 'queued' && page === 'triage') poll = setTimeout(render, 1600);
  } catch (err) {
    if (ticket !== generation) return;
    if (err.status === 401) { saveSession(null); loginPage(); tell(err.message, true); return; }
    shell(page, '<p class="alert">档案服务暂时不可用。</p><button data-reload>重新调阅</button>');
  }
}

function offerBatch(fields) {
  const options = [];
  for (let index = 0; index < 12; index += 1) {
    const vehicle = (fields[`vehicle-${index}`] ?? '').trim();
    const begins = fields[`begins-${index}`];
    const ends = fields[`ends-${index}`];
    const rh = fields[`rh-${index}`];
    const transfers = fields[`transfers-${index}`];
    if (!vehicle && !begins && !ends) continue;
    if (!vehicle || !begins || !ends || rh === '' || transfers === '') {
      throw new Error(`时段 ${index + 1} 填写不完整，请补齐车辆、起止时间、湿度与转运次数`);
    }
    options.push({vehicle, expected_rh: Number(rh), transfers: Number(transfers),
      begins_at: fromLocal(begins), ends_at: fromLocal(ends)});
  }
  if (!options.length) throw new Error('请至少录入一个备选时段');
  return options;
}

function target(action, fields) {
  const base = `/loans/${store.record?.id}`;
  if (action === 'intake') return ['/loans', {...fields, must_arrive: fromLocal(fields.must_arrive)}];
  if (action === 'crate') {
    const current = store.record.crate ?? {};
    return [`${base}/crate`, {...fields, seal_code: fields.seal_code || null,
      material: fields.material ?? current.material, packing: fields.packing ?? current.packing,
      route_type: fields.route_type ?? current.route_type, max_rh: Number(fields.max_rh), transfers: Number(fields.transfers)}, 'PUT'];
  }
  if (action === 'setup' || action === 'transit') {
    return [action === 'setup' ? '/schedule/setup' : `${base}/transit`,
      {...fields, begins_at: fromLocal(fields.begins_at), ends_at: fromLocal(fields.ends_at)}];
  }
  if (action === 'options') return [`${base}/transit/options`, {options: offerBatch(fields)}];
  if (action === 'triage') return [`${base}/triage`];
  return [`${base}/review/${action}`, fields];
}

const confirmations = {intake: '已建立借展档案', crate: '已保存检查记录', setup: '已登记展厅布置',
  triage: '已提交风险分流', options: '备选时段已评分并归档', witness: '已签署开箱见证', decision: '已记录主管决定',
  sample: '封签抽检通过', reopen: '已重开复核'};

app.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.dataset.action) return;
  event.preventDefault();
  const action = form.dataset.action;
  const fields = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button:not([type="button"])');
  button.disabled = true;
  try {
    if (action === 'login') {
      saveSession(await api('/auth/login', {method: 'POST', data: fields}));
      history.replaceState(null, '', '#archive');
    } else {
      const [path, data, method = 'POST'] = target(action, fields);
      const response = await authed(path, {data, method});
      if (action === 'intake') history.replaceState(null, '', `#archive/${response.id}`);
      if (action === 'setup' || action === 'transit') store.scheduleDay = fields.begins_at.slice(0, 10);
      if (action === 'options' && response.transit) store.scheduleDay = toLocal(response.transit.begins_at).slice(0, 10);
      const allConflict = action === 'options' && response.booking?.outcome === 'all_conflict';
      const conflict = action === 'transit' && response.transit?.status === 'conflict';
      tell(action === 'transit' ? (conflict ? response.transit.conflict_reason : '运输窗口已确认')
        : action === 'options' ? bookingRules[response.booking?.rule] ?? confirmations.options
        : confirmations[action], conflict || allConflict);
      form.closest('dialog')?.close();
    }
    await render();
  } catch (err) {
    tell(err.message, true);
    if (err.status === 401 && action !== 'login') { saveSession(null); loginPage(); }
  } finally { button.disabled = false; }
});

app.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.demo) {
    const form = app.querySelector('form');
    form.elements.username.value = button.dataset.demo;
    form.elements.password.value = 'MuseumDemo!26';
    form.elements.password.focus();
  }
  if (button.dataset.openDialog) document.getElementById(button.dataset.openDialog).showModal();
  if (button.hasAttribute('data-close-dialog')) button.closest('dialog').close();
  if (button.hasAttribute('data-logout')) {
    saveSession(null);
    notice.hidden = true;
    await render();
  }
  if (button.hasAttribute('data-reload')) await render();
  if (button.hasAttribute('data-dispatch')) {
    button.disabled = true;
    try {
      await authed(`/loans/${store.record.id}/dispatch`, {method: 'POST'});
      tell('派车已确认，借展档案已封存');
      await render();
    } catch (err) { tell(err.message, true); }
    finally { button.disabled = false; }
  }
});

app.addEventListener('change', (event) => {
  if (event.target.id === 'schedule-day') { store.scheduleDay = event.target.value; render(); }
});
window.addEventListener('hashchange', () => { store.scheduleDay = ''; render(); });

if (store.token) {
  try { store.staff = await authed('/auth/me'); }
  catch { saveSession(null); }
}
await render();
