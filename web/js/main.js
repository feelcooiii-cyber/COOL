// 進入點:路由(網址 # 後面)、頂列、資料更新狀態
import { $, $$ } from './util.js';
import { loadSettings, loadStatus, state } from './state.js';
import { toast } from './ui.js';
import { lobbyScreen } from './screens/lobby.js';
import { contestantScreen, editorScreen } from './screens/contestant.js';
import { playScreen } from './screens/play.js';
import { resultScreen } from './screens/result.js';
import { boardScreen } from './screens/board.js';
import { journalScreen } from './screens/journal.js';
import { dataScreen } from './screens/data.js';
import { settingsScreen } from './screens/settings.js';
import { onChange as onCatalog, refresh as refreshCatalog } from './local/catalog.js';

const routes = [
  [/^#?\/?$/, lobbyScreen, 'lobby'],
  [/^#\/c\/(\d+)$/, contestantScreen, 'lobby'],
  [/^#\/new$/, editorScreen, 'lobby'],
  [/^#\/edit\/(\d+)$/, editorScreen, 'lobby'],
  [/^#\/copy\/(\d+)$/, (v, id) => editorScreen(v, id, true), 'lobby'],
  [/^#\/play\/(\d+)$/, playScreen, 'play'],
  [/^#\/result\/(\d+)$/, resultScreen, 'lobby'],
  [/^#\/board$/, boardScreen, 'board'],
  [/^#\/journal$/, journalScreen, 'journal'],
  [/^#\/data$/, dataScreen, 'data'],
  [/^#\/settings$/, settingsScreen, 'settings'],
];

let current = null;
let seq = 0;

async function render() {
  const my = ++seq;
  if (current && current.destroy) { try { await current.destroy(); } catch (e) { console.error(e); } }
  current = null;
  const view = $('#view');
  const h = location.hash || '#/';
  let hit = null;
  for (const [re, fn, nav] of routes) { const m = h.match(re); if (m) { hit = { fn, nav, args: m.slice(1) }; break; } }
  if (!hit) { location.hash = '#/'; return; }
  document.body.classList.toggle('playing', hit.nav === 'play');
  $$('nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === hit.nav));
  view.innerHTML = '<div class="loading">載入中…</div>';
  window.scrollTo(0, 0);
  try {
    const r = await hit.fn(view, ...hit.args);
    if (my === seq) current = r || null;
    else if (r && r.destroy) r.destroy();
  } catch (e) {
    console.error(e);
    if (my === seq) view.innerHTML = `<div class="empty">出錯了:${e.message}</div>`;
  }
}

function jobText(s) {
  const j = s.job || {};
  const d = s.data || {};
  const cls = j.state === 'busy' || j.state === 'starting' ? 'busy' : j.state === 'error' ? 'err' : '';
  const info = d.last ? `行情到 ${d.last} · ${d.sessions} 盤` : '還沒有行情';
  const msg = cls === 'busy' ? `${j.msg}${j.total ? ` ${j.done}/${j.total}` : ''}` : cls === 'err' ? (j.msg || '資料更新失敗') : info;
  return `<span class="dot ${cls}"></span><span>${msg}</span>`;
}

let lastState = null;
async function pollStatus() {
  try {
    const s = await loadStatus();
    $('#job').innerHTML = jobText(s);
    const st = s.job && s.job.state;
    lastState = st;
  } catch (e) {
    $('#job').innerHTML = `<span class="dot err"></span><span>${e.message}</span>`;
  }
}

async function boot() {
  try {
    await Promise.all([loadStatus(), loadSettings()]);
    $('#job').innerHTML = jobText(state.status);
    lastState = state.status.job && state.status.job.state;
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">${e.message}</div>`;
    return;
  }
  window.addEventListener('hashchange', render);
  setInterval(pollStatus, 5000);
  onCatalog(() => {
    toast('有新的行情了', 'good');
    pollStatus();
    if (!document.body.classList.contains('playing')) window.dispatchEvent(new CustomEvent('arena:data'));
  });
  window.addEventListener('arena:nodata', e => toast(e.detail || '目前沒有新的行情', e.detail ? 'warn' : 'info'));
  setInterval(() => refreshCatalog(), 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshCatalog(); });
  render();
}
boot();

// 離線快取(加到主畫面後沒網路也能開)
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('service worker 註冊失敗', e));
}
