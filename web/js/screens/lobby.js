// 大廳:參賽者卡片、未完成的局、最近戰果、資料狀態
import { api } from '../api.js';
import { avatar, confirmBox, rankBadge, toast } from '../ui.js';
import { esc, fmtInt, fmtPct, fmtSigned, upDn, ago, weekday } from '../util.js';
import { loadOverview, prod, state } from '../state.js';
import { contestantStats, FORMAT_NAME, MODE_NAME, gameBeat } from '../stats.js';
import { startFlow } from './start.js';
import { finalizeGame } from './play.js';

export async function lobbyScreen(view) {
  const [ov, st] = await Promise.all([loadOverview(true), api.get('/api/status')]);
  const cs = ov.contestants;
  const byId = new Map(cs.map(c => [c.id, c]));
  const cards = cs.map(c => {
    const s = contestantStats(c, ov, { mult: prod(c.product).mult });
    const n = s.st.n || 0;
    return `<div class="ccard" data-c="${c.id}">
      <div class="top">${avatar(c, 46)}<div style="min-width:0"><div class="name">${esc(c.name)}</div>
        <div class="sub">${c.kind === 'monkey' ? '電腦 · 隨機猴子' : '真人操作'} · ${esc(prod(c.product).name)}</div></div>
        <span class="spacer"></span>${c.kind === 'monkey' ? '<span class="rank r-rookie">對照組</span>' : rankBadge(s.rank)}</div>
      <div class="kpis">
        <div class="kpi"><div class="k">正式交易</div><div class="v">${fmtInt(n)} 筆</div></div>
        <div class="kpi"><div class="k">期望值／筆</div><div class="v ${upDn(s.st.exp)}">${n ? fmtSigned(s.st.exp) : '—'}</div></div>
        <div class="kpi"><div class="k">${c.kind === 'monkey' ? '勝率' : '贏過猴子'}</div><div class="v">${c.kind === 'monkey' ? fmtPct(s.st.winRate) : (s.beat == null ? '—' : fmtPct(s.beat))}</div></div>
      </div>
      <div class="acts"><button class="btn primary" data-go="${c.id}">${c.kind === 'monkey' ? '下場跑' : '開始比賽'}</button>
        <button class="btn" data-stat="${c.id}">戰績</button></div>
    </div>`;
  }).join('');
  const recent = [...ov.games].sort((a, b) => b.finished - a.finished).slice(0, 10).map(g => {
    const c = byId.get(g.contestant_id);
    if (!c) return '';
    const s = g.summary || {};
    const b = gameBeat(g.monkey, s.pnl);
    return `<div class="g" data-g="${g.id}"><span class="grade ${s.grade && s.grade.length === 1 ? s.grade : 'x'}">${esc(s.grade || '—')}</span>
      <span style="min-width:0;flex:1"><b>${esc(c.name)}</b> <span class="muted">${esc(MODE_NAME[g.mode] || '')} · ${esc(FORMAT_NAME[g.format] || '')}</span>
      <br><span class="dim" style="font-size:12px">${esc(s.date || '')}(${s.date ? weekday(s.date) : ''})${esc(s.label || '')} · ${ago(g.finished)}${b != null ? ` · 贏過 ${Math.round(b * 100)}% 猴子` : ''}</span></span>
      <span class="num ${upDn(s.pnl)}">${fmtSigned(s.pnl)}</span></div>`;
  }).join('');
  const act = (st.active || []);
  const d = st.data || {};
  view.innerHTML = `
    ${act.map(a => `<div class="banner"><span>⏸ <b>${esc(a.name)}</b> 有一局${esc(FORMAT_NAME[a.format] || '')}(${esc(MODE_NAME[a.mode] || '')})還沒結束。</span>
      <span class="spacer"></span><button class="btn primary sm" data-resume="${a.id}">繼續</button>
      <button class="btn sm" data-final="${a.id}">直接結算</button></div>`).join('')}
    <div class="lobby">
      <div>
        <div class="page-head"><h1>參賽者</h1><span class="note">每位參賽者代表一種策略,帳戶和戰績完全分開</span></div>
        <div class="cgrid">${cards}<div class="ccard add" data-new><div class="plus">＋</div><div>新增參賽者</div>
          <div class="note">自己操作,或電腦隨機猴子</div></div></div>
      </div>
      <div>
        <div class="side-card"><h3>行情資料</h3>
          <div class="kv"><span class="k">期交所逐筆</span><span class="v">${esc(d.first || '—')} ~ ${esc(d.last || '—')}</span></div>
          <div class="kv"><span class="k">盤數</span><span class="v">${fmtInt(d.sessions)} 盤</span></div>
          <div class="kv"><span class="k">快速局(日＋夜)</span><span class="v">${fmtInt(d.quick_pairs)} 局</span></div>
          <p class="note" style="margin:8px 0 0">每個交易日晚上自動加入當天的行情;打開 App 時會檢查。玩到哪一盤才下載那一盤,下載過的沒網路也能玩。</p>
        </div>
        <div class="side-card"><h3>最近戰果</h3><div class="glist">${recent || '<div class="note">還沒有比賽紀錄</div>'}</div></div>
        <div class="side-card"><h3>怎麼玩</h3><ol class="note" style="margin:0;padding-left:18px">
          <li>新增參賽者,寫下他的策略與規則。</li><li>開始比賽:系統抽一段你沒看過的行情重播。</li>
          <li>用下方的買進／賣出按鈕下單;限價、停損按了再點圖選價位。</li><li>結算看評分、教練講評、和猴子比。</li>
          <li>累積筆數後,段位告訴你策略是不是真的有效。</li></ol></div>
      </div>
    </div>`;
  view.querySelector('[data-new]').onclick = () => { location.hash = '#/new'; };
  view.querySelectorAll('.ccard[data-c]').forEach(el => el.onclick = e => {
    if (e.target.closest('button')) return;
    location.hash = '#/c/' + el.dataset.c;
  });
  view.querySelectorAll('[data-go]').forEach(b => b.onclick = async () => {
    const c = byId.get(+b.dataset.go);
    if (act.length && c.kind === 'human') { toast('先把還沒結束的那一局繼續完或結算', 'warn'); return; }
    await startFlow(c);
    if (c.kind === 'monkey') window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  view.querySelectorAll('[data-stat]').forEach(b => b.onclick = () => { location.hash = '#/c/' + b.dataset.stat; });
  view.querySelectorAll('.glist .g').forEach(el => el.onclick = () => { location.hash = '#/result/' + el.dataset.g; });
  view.querySelectorAll('[data-resume]').forEach(b => b.onclick = () => { location.hash = '#/play/' + b.dataset.resume; });
  view.querySelectorAll('[data-final]').forEach(b => b.onclick = async () => {
    if (!await confirmBox('直接結算', '用上次存檔的時間點把部位平倉並結算,剩下的時間不再交易。', '結算')) return;
    try { await finalizeGame(+b.dataset.final); location.hash = '#/result/' + b.dataset.final; } catch (e) { toast(e.message, 'bad'); }
  });
  const onData = () => window.dispatchEvent(new HashChangeEvent('hashchange'));   // 讓路由重畫(會先清掉這一頁)
  window.addEventListener('arena:data', onData);
  return { destroy: () => window.removeEventListener('arena:data', onData) };
}
