// 結算畫面:評分、揭曉日期、和猴子比、成交規則對照、K 線回放、權益曲線、每筆檢討(可以寫日誌)、成就
import { api } from '../api.js';
import { Game, loadGameData } from '../game.js';
import { ArenaChart, equityChart } from '../chart.js';
import { barTime, buildStream, makeBars } from '../data.js';
import { ACH, COUNTED, contestantStats, FORMAT_NAME, gameBeat, MODE_NAME } from '../stats.js';
import { sfx } from '../sound.js';
import { avatar, rankBadge, toast } from '../ui.js';
import { $, dur, esc, fmtInt, fmtNum, fmtPct, fmtSigned, hms, upDn, weekday } from '../util.js';
import { invalidate, loadOverview, prod } from '../state.js';
import { startGame } from './start.js';

const EXIT = { sl: '停損', tp: '停利', manual: '手動', end: '收盤平倉', quit: '提前結束', loss: '虧損上限', risk: '保證金不足', flat: '手動' };

export async function resultScreen(view, gidStr) {
  const gid = +gidStr;
  const g = await api.get('/api/game/' + gid);
  if (g.status === 'playing') { location.hash = '#/play/' + gid; return; }
  const [c, ov] = await Promise.all([api.get('/api/contestant/' + g.contestant_id), loadOverview(true)]);
  const spec = g.spec, s = g.summary || {}, P = prod(spec.product), mult = P.mult;
  const trades = g.trades || [];
  const counted = COUNTED.has(g.mode);
  const beat = gameBeat(g.monkey, s.pnl);
  const cs = c.kind === 'human' ? contestantStats(c, ov, { mult }) : null;
  let newAch = [];
  try { newAch = JSON.parse(sessionStorage.getItem('arena.newach.' + gid) || '[]'); sessionStorage.removeItem('arena.newach.' + gid); } catch (e) { newAch = []; }
  const grade = s.grade || '—';
  const pts = trades.length ? trades.reduce((a, t) => a + t.pnl / mult / Math.max(1, t.qty), 0) : 0;
  const reveal = spec.format === 'quick'
    ? `<b>${esc(spec.date)}(${weekday(spec.date)})</b> 日盤 08:45–13:45 ＋ 夜盤 15:00–05:00`
    : `<b>${esc(spec.date)}(${weekday(spec.date)})</b> ${esc(spec.label)}`;
  const insights = gameInsights(trades, s, mult);
  const tagOpts = ['', ...(c.tags || [])];

  view.innerHTML = `
  <div class="page-head">${avatar(c, 40)}<div><h2>${esc(c.name)} · ${esc(MODE_NAME[g.mode] || '')} · ${esc(FORMAT_NAME[g.format] || '')}${spec.scenario ? ' · ' + esc(spec.scenario) : ''}</h2>
    <div class="note">${counted ? '計入戰績' : '練習,不計入戰績'} · ${esc(P.name)} ${esc(spec.month)} · 第 ${gid} 局</div></div>
    <span class="spacer"></span>
    ${c.kind === 'human' ? `<button class="btn primary" id="again">再來一局</button>` : ''}
    <button class="btn" id="stats">看戰績</button><button class="btn" id="home">回大廳</button></div>
  <div class="card result-head">
    <div class="big-grade ${grade.length === 1 ? grade : 'x'}" title="單局評分只看過程">${esc(grade)}</div>
    <div>
      <div class="result-pnl ${upDn(s.pnl)}">${fmtSigned(s.pnl)} <span style="font-size:18px">元</span></div>
      <div class="muted">${trades.length} 筆交易 · 平均每口 ${fmtSigned(trades.length ? pts / trades.length : null, 1)} 點(扣成本) · 成本 ${fmtInt(s.costs)} 元${s.reason === 'quit' ? ' · 提前結束' : ''}</div>
      <div class="reveal">${spec.blind ? '揭曉:這一局是 ' : ''}${reveal}${spec.price_offset ? ` · 比賽時價位平移了 ${fmtSigned(spec.price_offset)} 點` : ''}</div>
    </div>
    <div style="min-width:240px">${(s.items || []).map(i => `<div class="kv"><span class="k">${esc(i.k)}</span><span class="v ${i.v < 0 ? 'warn' : ''}">${i.v ? i.v : '✓'}</span></div>`).join('')}
      ${s.score != null ? `<div class="kv"><span class="k">過程分數</span><span class="v">${s.score}</span></div>` : ''}</div>
  </div>
  <div class="mcards section">
    <div class="mcard"><div class="k">勝率</div><div class="v">${fmtPct(s.winRate)}</div><div class="s">${s.wins || 0} 勝 ${(s.n || 0) - (s.wins || 0)} 敗</div></div>
    <div class="mcard"><div class="k">贏過隨機猴子</div><div class="v">${beat == null ? '—' : fmtPct(beat)}</div><div class="s">${g.monkey && g.monkey.length ? `200 隻猴子中位數 ${fmtSigned(s.monkeyMedian)} 元` : '沒有交易就不比'}</div></div>
    <div class="mcard"><div class="k">單局最大回撤</div><div class="v dn">${fmtInt(s.maxDD)}</div><div class="s">元(含未實現)</div></div>
    <div class="mcard"><div class="k">追價／沒停損</div><div class="v">${s.chased || 0} / ${s.noStop || 0}</div><div class="s">筆</div></div>
    <div class="mcard"><div class="k">被規則擋下</div><div class="v">${s.blocked || 0}</div><div class="s">次</div></div>
    ${s.alt && s.alt.touch != null ? `<div class="mcard"><div class="k">限價單碰到就成交的話</div><div class="v ${upDn(s.alt.touch)}">${fmtSigned(s.alt.touch)}</div><div class="s">其他操作不變;和實際的差就是排隊的不確定</div></div>` : ''}
  </div>
  ${newAch.length ? `<div class="section"><h3>解鎖成就</h3><div class="ach-grid">${newAch.map(k => achCard(k, true)).join('')}</div></div>` : ''}
  <div class="section grid cols-2">
    <div><h3 style="margin-bottom:8px">K 線回放</h3><div class="review-chart"><div id="rchart"></div></div>
      <div class="row" style="margin-top:6px"><div class="seg" id="rtf"><button data-tf="1">1 分</button><button data-tf="5" class="on">5 分</button><button data-tf="15">15 分</button></div>
      <span class="note">紅箭頭買進、綠箭頭賣出</span></div></div>
    <div><h3 style="margin-bottom:8px">權益變化</h3><div class="card" style="padding:8px"><div class="eq-chart"><div id="eqc"></div></div></div>
      <h3 style="margin:16px 0 8px">教練講評</h3>
      <div class="card"><ul class="coach" style="margin:0;padding-left:18px">${insights.map(x => `<li class="${x.level}">${esc(x.text)}</li>`).join('') || '<li>這一局沒有特別要提醒的。</li>'}</ul></div>
      ${cs ? `<h3 style="margin:16px 0 8px">段位</h3><div class="card row">${rankBadge(cs.rank)}<span class="note">正式交易 ${cs.st.n || 0} 筆 · 下一步:${esc(cs.rank.next)}</span></div>` : ''}
    </div>
  </div>
  <div class="section"><h3>每一筆檢討(可以寫日誌,會用在戰績分析)</h3>
    <div class="card" style="overflow:auto"><table class="t big"><thead><tr>
      <th>#</th><th>多空</th><th class="r">口</th><th>進場</th><th>出場</th><th class="r">進場價</th><th class="r">出場價</th>
      <th class="r">點數</th><th class="r">損益(元)</th><th class="r">最大有利</th><th class="r">最大不利</th><th class="r">R</th><th>持有</th><th>出場</th><th>標記</th>
      <th>理由</th><th>照策略?</th><th>心得</th></tr></thead>
      <tbody>${trades.map(t => tradeRow(t, spec, tagOpts)).join('') || '<tr><td colspan="18" class="dim">這一局沒有交易</td></tr>'}</tbody></table></div></div>`;

  if (newAch.length) { sfx.achieve(); newAch.forEach(k => toast(`解鎖成就:${ACH[k] ? ACH[k].name : k}`, 'gold', 4000)); }
  $('#home', view).onclick = () => { location.hash = '#/'; };
  $('#stats', view).onclick = () => { location.hash = '#/c/' + c.id; };
  if ($('#again', view)) $('#again', view).onclick = () => startGame(c, g.mode === 'practice' ? 'ranked' : g.mode, g.format, g.scenario);

  // 日誌:理由、照策略、心得
  view.querySelectorAll('[data-tid]').forEach(tr => {
    const id = +tr.dataset.tid;
    const send = async body => { try { await api.post('/api/trade/' + id, body); invalidate(); } catch (e) { toast(e.message, 'bad'); } };
    const sel = tr.querySelector('select');
    if (sel) sel.onchange = () => send({ tag: sel.value || null });
    tr.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
      const v = +b.dataset.f;
      tr.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('primary', x === b));
      send({ followed: v });
    });
    const note = tr.querySelector('input.journal-note');
    if (note) note.onchange = () => send({ note: note.value });
  });

  // 圖:重算一次拿到每一筆成交(同樣的操作紀錄一定得到同樣的結果)
  const charts = [];
  try {
    const bins = await loadGameData(spec);
    const game = new Game(spec, c, bins);
    game.replay(g.orders || [], (s.playedTo ? s.playedTo * 1000 : game.end));
    game.finish(s.reason || 'end');
    const fills = game.engine.fills;
    const rc = new ArenaChart($('#rchart', view), { blind: false, offset: 0 });
    charts.push(rc);
    const ctx = bins.ctx.filter(Boolean).map(b => buildStream([b]));
    const draw = tf => {
      const bars = [];
      for (const cs2 of ctx) bars.push(...makeBars(cs2.T, cs2.P, cs2.Q, 0, cs2.n, tf));
      const st = game.stream;
      const own = makeBars(st.T, st.P, st.Q, 0, st.n, tf).filter(b => b.time * 1000 - 8 * 3600e3 <= game.end);
      rc.setBars(bars.filter(b => !own.length || b.time < own[0].time).concat(own));
      rc.setMarkers(fills.map(f => ({ time: barTime(f.t, tf), position: f.side > 0 ? 'belowBar' : 'aboveBar', color: f.side > 0 ? '#ff4d4f' : '#1fbf75', shape: f.side > 0 ? 'arrowUp' : 'arrowDown', text: (f.side > 0 ? '買' : '賣') + f.qty })));
      const t0 = barTime(game.start, tf), t1 = barTime(game.end, tf);
      const all = bars.concat(own);
      const i0 = all.findIndex(b => b.time >= t0), i1 = all.findIndex(b => b.time >= t1);
      rc.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i0 - 10), to: (i1 < 0 ? all.length : i1) + 5 });
    };
    draw(5);
    view.querySelectorAll('#rtf button').forEach(b => b.onclick = () => {
      view.querySelectorAll('#rtf button').forEach(x => x.classList.toggle('on', x === b));
      draw(+b.dataset.tf);
    });
    const ec = g.equity && g.equity.length > 1 ? equityChart($('#eqc', view), g.equity, c.capital, false) : null;
    if (ec) charts.push(ec);
    else $('#eqc', view).innerHTML = '<div class="note" style="padding:20px">沒有權益變化</div>';
  } catch (e) {
    console.error(e);
    $('#rchart', view).innerHTML = `<div class="note" style="padding:20px">畫不出回放:${esc(e.message)}</div>`;
  }
  return { destroy: () => charts.forEach(x => { try { x.remove(); } catch (e) { /* 已移除 */ } }) };
}

function tradeRow(t, spec, tagOpts) {
  const off = 0;
  const fl = t.flags || {};
  const marks = [fl.chased ? '<span class="pill warn">追價</span>' : '', fl.noStop ? '<span class="pill up">無停損</span>' : ''].join(' ');
  const pts = t.points;
  return `<tr data-tid="${t.id}"><td>${t.seq}</td><td class="${t.dir > 0 ? 'up' : 'dn'}">${t.dir > 0 ? '多' : '空'}</td><td class="r">${t.qty}</td>
    <td>${hms(t.entry_t * 1000)}</td><td>${hms(t.exit_t * 1000)}</td><td class="r">${fmtNum(t.entry_px + off, 0)}</td><td class="r">${fmtNum(t.exit_px + off, 0)}</td>
    <td class="r ${upDn(pts)}">${fmtSigned(pts, 1)}</td><td class="r ${upDn(t.pnl)}">${fmtSigned(t.pnl)}</td>
    <td class="r up">${fmtSigned(t.mfe, 0)}</td><td class="r dn">${fmtSigned(t.mae, 0)}</td><td class="r">${t.r == null ? '—' : fmtNum(t.r, 1)}</td>
    <td>${dur(t.hold * 1000)}</td><td>${esc(EXIT[fl.exitBy] || fl.exitBy || '')}</td><td>${marks}</td>
    <td><select>${tagOpts.map(o => `<option ${o === (t.tag || '') ? 'selected' : ''} value="${esc(o)}">${esc(o || '(無)')}</option>`).join('')}</select></td>
    <td><button class="btn sm ${t.followed === 1 ? 'primary' : ''}" data-f="1">照</button> <button class="btn sm ${t.followed === 0 ? 'primary' : ''}" data-f="0">沒照</button></td>
    <td><input type="text" class="journal-note" value="${esc(t.note || '')}" placeholder="這筆為什麼進出場"></td></tr>`;
}

export function achCard(code, isNew = false, locked = false) {
  const a = ACH[code] || { name: code, desc: '' };
  return `<div class="ach ${isNew ? 'new' : ''} ${locked ? 'locked' : ''}"><div class="ic">★</div><div><div class="n">${esc(a.name)}</div><div class="d">${esc(a.desc)}</div></div></div>`;
}

// 單局講評:每一筆最值得注意的地方
function gameInsights(trades, s, mult) {
  const out = [];
  for (const n of s.notes || []) out.push({ level: 'warn', text: n });
  for (const t of trades) {
    const net = t.pnl / mult / Math.max(1, t.qty);
    if (net < 0 && t.mfe >= 20 && t.mfe >= Math.abs(net)) out.push({ level: 'warn', text: `第 ${t.seq} 筆曾經賺 ${Math.round(t.mfe)} 點,最後虧 ${fmtNum(-net, 1)} 點:有利的時候沒有保護獲利。` });
    if (t.flags && t.flags.noStop && t.mae <= -30) out.push({ level: 'warn', text: `第 ${t.seq} 筆沒有停損,最深曾經倒賠 ${Math.round(-t.mae)} 點。` });
    if (t.flags && t.flags.chased) out.push({ level: 'warn', text: `第 ${t.seq} 筆追價:進場前 30 秒已經往同方向走了 ${t.flags.move} 點。` });
    if (t.r != null && t.r >= 2) out.push({ level: 'good', text: `第 ${t.seq} 筆賺到 ${fmtNum(t.r, 1)}R,抱得住。` });
  }
  const effs = trades.filter(t => t.pnl > 0 && t.eff != null);
  if (effs.length >= 2) {
    const m = effs.reduce((a, t) => a + t.eff, 0) / effs.length;
    out.push({ level: m < 0.35 ? 'warn' : 'info', text: `獲利單平均拿到持有期間最大有利的 ${Math.round(m * 100)}%。` });
  }
  if (!trades.length) out.push({ level: 'info', text: '這一局沒有出手。觀望也是一種選擇,但正式賽每一局都會用掉一段行情。' });
  return out.slice(0, 12);
}
