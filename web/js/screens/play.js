// 比賽畫面:重播行情、下單、結算。時間用「交易時間」前進(日盤收盤到夜盤開盤的休市直接跳過)。
import { api } from '../api.js';
import { Game, loadGameData } from '../game.js';
import { ArenaChart } from '../chart.js';
import { BarBuilder, barTime, buildStream, makeBars } from '../data.js';
import { matchedMonkey } from '../monkey.js';
import { COUNTED, newAchievements } from '../stats.js';
import { sfx } from '../sound.js';
import { confirmBox, toast } from '../ui.js';
import { $, esc, fmtInt, fmtSigned, hms, median, upDn } from '../util.js';
import { invalidate, loadOverview, prod, state } from '../state.js';

const SPEEDS = [1, 2, 5, 10, 30, 60];
const FMT = { hour: '一小時局', session: '整盤', quick: '快速局' };
const MODE = { ranked: '正式賽', scenario: '情境關卡', practice: '練習場' };

// 結算並存檔(比賽畫面結束、大廳「直接結算」共用)
async function settle(gid, game, c, spec, reason) {
  const res = game.finish(reason);
  const monkey = matchedMonkey(game, res.trades, 200, spec.seed || 1);
  res.summary.monkeyMedian = monkey.length ? median(monkey) : null;
  if (game.log.some(x => x.a === 'lmt') && (spec.settings.fill_rule || 'through') === 'through') {
    const g2 = new Game(spec, c, game.bins, { fillRule: 'touch' });
    g2.replay(game.log, game.now);
    res.summary.alt = { touch: g2.finish(reason).summary.pnl };
  }
  let ach = [];
  if (COUNTED.has(spec.mode) && c.kind === 'human') {
    const ov = await loadOverview(true);
    const prevGames = ov.games.filter(x => x.contestant_id === c.id && COUNTED.has(x.mode));
    const gids = new Set(prevGames.map(x => x.id));
    const prevTrades = ov.trades.filter(t => gids.has(t.game_id));
    const have = new Set(ov.achievements.filter(a => a.contestant_id === c.id).map(a => a.code));
    ach = newAchievements(have, prevGames, prevTrades, { mode: spec.mode, format: spec.format, scenario: spec.scenario, summary: res.summary, monkey }, res.trades);
  }
  await api.post(`/api/game/${gid}/finish`, {
    orders: game.log, saved_t: game.now, summary: res.summary, trades: res.trades, equity: res.equity, monkey, achievements: ach,
  });
  invalidate();
  try { sessionStorage.setItem('arena.newach.' + gid, JSON.stringify(ach)); } catch (e) { /* 無痕模式 */ }
  return res;
}

export async function finalizeGame(gid) {
  const g = await api.get('/api/game/' + gid);
  if (g.status !== 'playing') return;
  const c = await api.get('/api/contestant/' + g.contestant_id);
  const bins = await loadGameData(g.spec);
  const game = new Game(g.spec, c, bins);
  game.replay(g.orders || [], g.saved_t || game.start);
  await settle(gid, game, c, g.spec, 'quit');
}

function loadBracket(cid, rules) {
  let b = { on: true, sl: 40, tp: 80 };
  try { b = { ...b, ...JSON.parse(localStorage.getItem('arena.bracket.' + cid) || '{}') }; } catch (e) { /* 預設 */ }
  if (rules.requireStop) b.on = true;
  return b;
}

export async function playScreen(view, gidStr) {
  const gid = +gidStr;
  const g = await api.get('/api/game/' + gid);
  if (g.status !== 'playing') { location.hash = '#/result/' + gid; return; }
  const c = await api.get('/api/contestant/' + g.contestant_id);
  const spec = g.spec;
  view.innerHTML = '<div class="loading">載入行情…</div>';
  const bins = await loadGameData(spec);
  let game = new Game(spec, c, bins);
  const resumed = (g.orders && g.orders.length > 0) || !!g.saved_t;
  if (resumed) game.replay(g.orders || [], g.saved_t || game.start);

  const P = prod(spec.product);
  const off = spec.price_offset || 0;
  const counted = spec.mode !== 'practice';
  const quick = spec.format === 'quick';
  const blind = spec.blind;
  const L = game.tradingLen;
  const rules = c.rules || {};
  const tags = c.tags || [];
  const st = state.settings;
  let u = game.tradingElapsed(game.now);
  let started = false, running = false, ending = false, destroyed = false;
  let speed = quick ? L / (spec.fixed_seconds * 1000) : (spec.format === 'session' ? 10 : 5);
  let smart = !quick && !!st.smart_fast;
  let tf = quick ? 1 : (spec.format === 'session' ? 5 : 1);
  let qty = 1;
  let tag = null;
  let pick = null;
  const br = loadBracket(c.id, rules);
  const fills = [];
  const tape = [];
  let lastSeg = game.engine.lastSeg;

  const monthTxt = blind ? '近月' : spec.month.slice(0, 4) + '/' + spec.month.slice(4);
  const title = `${MODE[spec.mode]} · ${FMT[spec.format]}${spec.scenario ? ' · ' + spec.scenario : ''}`;
  const where = blind ? (quick ? '日盤＋夜盤 · 日期隱藏' : `${spec.label} · 日期隱藏`) : `${spec.date} ${quick ? '日盤＋夜盤' : spec.label}`;
  view.innerHTML = `
  <div class="play">
    <div class="ptop">
      <button class="icon-btn" id="back" title="回大廳(這一局會保留,可以繼續)">←</button>
      <span class="pill ${counted ? 'accent' : ''}">${esc(title)}</span>
      <span class="title">${esc(c.name)}</span><span class="muted">${esc(where)}</span>
      <span class="clock" id="clock">--:--:--</span>
      <div class="prog ${quick ? 'quick' : ''}"><i id="prog"></i></div>
      <span class="remain" id="remain"></span>
      ${quick ? `<span class="pill warn" title="5 分鐘走完日盤＋夜盤">約 ${Math.round(speed)} 倍速</span>` :
        `<div class="seg" id="speeds">${SPEEDS.map(s => `<button data-s="${s}">${s}×</button>`).join('')}</div>
         <button class="btn sm ${smart ? 'primary' : ''}" id="smart" title="沒部位、行情安靜時自動加速到 ${st.fast_speed}×">⚡ 智慧快轉</button>`}
      <button class="btn sm" id="pp">▶ 開始</button>
      ${spec.mode === 'practice' ? '<button class="btn sm" id="rew" title="倒帶 5 分鐘(練習場才有)">⟲ 5 分</button>' : ''}
      <button class="btn sm danger" id="quit">結束</button>
    </div>
    <div class="pmain">
      <div class="chart-wrap" id="cwrap">
        <div id="chart"></div>
        <div class="chart-tools">
          <div class="seg" id="tfs"><button data-tf="1">1 分</button><button data-tf="5">5 分</button><button data-tf="15">15 分</button></div>
          <button class="btn sm ghost" id="recent">回到最新</button>
          <span class="spacer"></span>
          <span>拖曳委託線可以改價 · 快速鍵:B 買 S 賣 F 平倉 R 反手 C 全撤 Q/W 限價 A/Z 停損 空白鍵 暫停</span>
        </div>
        <div class="pick-hint hidden" id="pickHint"></div>
        <div class="overlay" id="overlay"></div>
      </div>
      <div class="side">
        <div class="blk">
          <div class="row"><span class="muted">${esc(P.name)} ${esc(monthTxt)}</span><span class="spacer"></span><span class="ba" id="ba"></span></div>
          <div class="lastpx" id="last">—</div>
          <div class="ba" id="chg"></div>
        </div>
        <div class="blk">
          <div class="row" style="margin-bottom:8px"><span class="muted">口數</span>
            <div class="qty"><button class="btn sm" id="qm">−</button><input type="text" id="qty" value="1"><button class="btn sm" id="qp">＋</button></div>
            <span class="spacer"></span>${rules.maxLots ? `<span class="dim" style="font-size:12px">上限 ${rules.maxLots}</span>` : ''}</div>
          <div class="trade-btns"><button class="tb buy" id="buy">買進<small>B · 市價</small></button><button class="tb sell" id="sell">賣出<small>S · 市價</small></button></div>
          <div class="mini-btns">
            <button class="btn" id="lb">限價買<kbd>Q</kbd></button><button class="btn" id="ls">限價賣<kbd>W</kbd></button>
            <button class="btn" id="sb">停損買<kbd>A</kbd></button><button class="btn" id="ss">停損賣<kbd>Z</kbd></button>
            <button class="btn" id="flat">平倉<kbd>F</kbd></button><button class="btn" id="rev">反手<kbd>R</kbd></button>
            <button class="btn" id="cxa">全撤<kbd>C</kbd></button><button class="btn" id="pp2">暫停<kbd>␣</kbd></button>
          </div>
          <div class="bracket"><label class="chk"><input type="checkbox" id="bon" ${br.on ? 'checked' : ''} ${rules.requireStop ? 'disabled' : ''}> 進場自動帶</label>
            停損 <input type="number" id="bsl" min="0" value="${br.sl}"> 停利 <input type="number" id="btp" min="0" value="${br.tp}"> 點</div>
          ${tags.length ? `<div class="row" style="margin-top:8px"><span class="muted" style="font-size:12px">進場理由</span>
            <select id="tag"><option value="">(不選)</option>${tags.map(t => `<option>${esc(t)}</option>`).join('')}</select></div>` : ''}
        </div>
        <div class="blk">
          <div class="kv"><span class="k">部位</span><span class="v" id="pos">空手</span></div>
          <div class="kv"><span class="k">均價</span><span class="v" id="avg">—</span></div>
          <div class="kv"><span class="k">未實現</span><span class="v" id="unr">—</span></div>
          <div class="kv"><span class="k">本局損益</span><span class="big-pnl" id="pnl">0</span></div>
          <div class="kv"><span class="k">成本(手續費＋稅)</span><span class="v" id="cost">0</span></div>
          <div class="kv"><span class="k">權益</span><span class="v" id="eq">—</span></div>
          <div class="kv"><span class="k">保證金使用</span><span class="v" id="mgt">0%</span></div>
          <div class="bar" id="mgbar"><i id="mg"></i></div>
        </div>
        <div class="blk rules-blk" id="rules"></div>
        ${c.strategy && (c.strategy.entry || c.strategy.exit || c.strategy.stop || c.strategy.size) ? `<details class="blk strategy-blk" open><summary>策略卡</summary>
          ${c.strategy.entry ? `<p><b>進場</b> ${esc(c.strategy.entry)}</p>` : ''}${c.strategy.exit ? `<p><b>出場</b> ${esc(c.strategy.exit)}</p>` : ''}
          ${c.strategy.stop ? `<p><b>停損</b> ${esc(c.strategy.stop)}</p>` : ''}${c.strategy.size ? `<p><b>部位</b> ${esc(c.strategy.size)}</p>` : ''}</details>` : ''}
      </div>
    </div>
    <div class="pbottom">
      <div class="tape"><h4>成交明細</h4><div id="tape"></div></div>
      <div><h4>委託</h4><table class="t"><thead><tr><th>類型</th><th>買賣</th><th class="r">口</th><th class="r">價格</th><th>狀態</th><th></th></tr></thead><tbody id="ords"></tbody></table></div>
      <div><h4>本局交易</h4><table class="t"><thead><tr><th>#</th><th>多空</th><th class="r">口</th><th class="r">進場</th><th class="r">出場</th><th class="r">點數</th><th class="r">損益</th></tr></thead><tbody id="trs"></tbody></table></div>
    </div>
  </div>`;

  const chartEl = $('#chart', view);
  const chart = new ArenaChart(chartEl, { blind, offset: off });
  const ctxStreams = bins.ctx.filter(Boolean).map(b => buildStream([b]));
  let builder = null, drawnIdx = 0, barCount = 0;
  const startPx = game.priceAt(game.start) ?? game.stream.P[game.firstIdx] ?? null;

  function rebuildChart(keepView = false) {
    const bars = [];
    for (const cs of ctxStreams) bars.push(...makeBars(cs.T, cs.P, cs.Q, 0, cs.n, tf, off));
    const s = game.stream, upto = game.engine.i;
    const own = makeBars(s.T, s.P, s.Q, 0, upto, tf, off);
    const merged = bars.filter(b => !own.length || b.time < own[0].time).concat(own);
    chart.setBars(merged);
    barCount = merged.length;
    builder = new BarBuilder(tf, off);
    if (own.length) builder.cur = { ...own[own.length - 1] };
    drawnIdx = upto;
    refreshMarkers();
    if (!keepView) chart.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, barCount - (tf === 1 ? 150 : 90)), to: barCount + 8 });
  }
  function drawNewPrints() {
    const s = game.stream, upto = game.engine.i;
    if (upto <= drawnIdx) return;
    const done = [];
    let prev = builder.cur;
    for (let i = drawnIdx; i < upto; i++) {
      if (builder.push(s.T[i], s.P[i], s.Q[i]) && prev) done.push(prev);
      prev = builder.cur;
      if (i >= upto - 40) tape.push(i);
    }
    while (tape.length > 40) tape.shift();
    for (const b of done) { chart.update(b); }
    if (done.length) barCount += done.length;
    chart.update(builder.cur);
    drawnIdx = upto;
    tapeDirty = true;
  }

  // ── 標記與價格線 ──
  function refreshMarkers() {
    chart.setMarkers(fills.map(f => ({
      time: barTime(f.t, tf), position: f.side > 0 ? 'belowBar' : 'aboveBar', color: f.side > 0 ? '#ff4d4f' : '#1fbf75',
      shape: f.side > 0 ? 'arrowUp' : 'arrowDown',
      text: (f.role === 'sl' ? '停損' : f.role === 'tp' ? '停利' : f.liq === 'auc' ? '競價' : f.side > 0 ? '買' : '賣') + f.qty,
    })));
  }
  const ORD_NAME = o => {
    if (o.role === 'sl') return '停損';
    if (o.role === 'tp') return '停利';
    if (o.type === 'LMT') return o.side > 0 ? '限買' : '限賣';
    if (o.type === 'STP') return o.side > 0 ? '觸買' : '觸賣';
    return o.side > 0 ? '市買' : '市賣';
  };
  function lineOpt(o) {
    const col = o.role === 'sl' ? '#f5a524' : o.role === 'tp' ? '#4f8cff' : o.type === 'STP' ? '#f5a524' : (o.side > 0 ? '#ff4d4f' : '#1fbf75');
    return { color: col, title: `${ORD_NAME(o)} ${o.qty - o.filled}`, style: 2, width: 1 };
  }
  function syncLines() {
    const want = new Map();
    for (const o of game.engine.active) {
      const px = o.type === 'LMT' ? o.price : o.type === 'STP' ? o.trig : null;
      if (px == null) continue;
      want.set('o' + o.id, { price: px, opt: lineOpt(o) });
    }
    const e = game.engine;
    if (e.pos !== 0) want.set('avg', { price: Math.round(e.avg), opt: { color: '#c3cad6', title: `均價 ${e.pos > 0 ? '多' : '空'}${Math.abs(e.pos)}`, style: 0, width: 1 } });
    chart.syncLines(want);
  }

  // ── 面板 ──
  let tapeDirty = true, ordersDirty = true, tradesDirty = true, lastPanel = 0;
  const elv = id => $('#' + id, view);
  function fmtPx(p) { return p == null ? '—' : fmtInt(p + off); }
  function refreshPanel(force = false) {
    const now = performance.now();
    if (!force && now - lastPanel < 100) return;
    lastPanel = now;
    const e = game.engine;
    elv('clock').textContent = isFinite(game.now) ? hms(game.now) : '--:--:--';
    elv('prog').style.width = (100 * u / L).toFixed(2) + '%';
    const leftMs = L - u;
    elv('remain').textContent = quick ? `剩 ${Math.floor(leftMs / speed / 60000)}:${String(Math.floor(leftMs / speed / 1000) % 60).padStart(2, '0')}` : `剩 ${fmtLeft(leftMs)}`;
    if (e.last != null) {
      elv('last').textContent = fmtPx(e.last);
      elv('last').className = 'lastpx ' + (e.dir > 0 ? 'up' : e.dir < 0 ? 'dn' : '');
      elv('ba').textContent = `估買 ${fmtPx(e.bid())} / 估賣 ${fmtPx(e.ask())}`;
      if (startPx != null) { const d = e.last - startPx; elv('chg').innerHTML = `這一局開始以來 <span class="${upDn(d)}">${fmtSigned(d)} 點</span>`; }
    }
    elv('pos').innerHTML = e.pos === 0 ? '空手' : `<span class="${e.pos > 0 ? 'up' : 'dn'}">${e.pos > 0 ? '多' : '空'} ${Math.abs(e.pos)} 口</span>`;
    elv('avg').textContent = e.pos === 0 ? '—' : fmtPx(Math.round(e.avg * 10) / 10);
    const ur = e.unreal(), urPts = e.pos ? (e.last - e.avg) * Math.sign(e.pos) : 0;
    elv('unr').innerHTML = e.pos === 0 ? '—' : `<span class="${upDn(ur)}">${fmtSigned(urPts, 1)} 點 / ${fmtSigned(ur)}</span>`;
    const pnl = e.pnl();
    elv('pnl').textContent = fmtSigned(pnl);
    elv('pnl').className = 'big-pnl ' + upDn(pnl);
    elv('cost').textContent = fmtInt(e.costs);
    elv('eq').textContent = fmtInt(e.equity());
    const need = Math.abs(e.pos) * e.o.im, eq = e.equity();
    const used = eq > 0 ? need / eq : 1;
    elv('mgt').textContent = Math.round(used * 100) + '%';
    elv('mg').style.width = Math.min(100, used * 100) + '%';
    elv('mgbar').className = 'bar' + (used > 0.8 ? ' bad' : used > 0.5 ? ' hot' : '');
    refreshRules();
    if (tapeDirty) renderTape();
    if (ordersDirty) renderOrders();
    if (tradesDirty) renderTrades();
  }
  function fmtLeft(ms) {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} 時 ${m % 60} 分` : `${m} 分`;
  }
  function refreshRules() {
    const e = game.engine, lines = [];
    if (rules.maxLoss > 0) { const lost = Math.max(0, -e.pnl()); lines.push([`單局虧損 ${fmtInt(lost)} / 上限 ${fmtInt(rules.maxLoss)}`, game.lossLocked || lost > rules.maxLoss * 0.7]); }
    if (rules.maxTrades > 0) lines.push([`交易 ${game.openTrades()} / 上限 ${rules.maxTrades} 筆`, game.openTrades() >= rules.maxTrades]);
    if (rules.requireStop) lines.push(['進場一定要帶停損', false]);
    if (rules.maxLots) lines.push([`每筆最多 ${rules.maxLots} 口`, false]);
    if (game.cooldownUntil > game.now) lines.push([`冷靜中:還有 ${Math.ceil((game.cooldownUntil - game.now) / 60000)} 分鐘(市場時間)`, true]);
    if (game.lossLocked) lines.push(['已達單局虧損上限:只能平倉', true]);
    if (counted) lines.push([started && !running ? '暫停中不能下單(正式比賽)' : '正式比賽:不能倒帶、暫停時不能下單', started && !running]);
    if (game.blocked.length) lines.push([`被規則擋下 ${game.blocked.length} 次`, true]);
    const html = lines.length ? lines.map(([t, bad]) => `<div class="r ${bad ? 'bad' : ''}">${bad ? '⚠' : '•'} ${esc(t)}</div>`).join('') : '<div class="r">沒有設定規則</div>';
    const box = elv('rules');
    if (box.innerHTML !== html) box.innerHTML = html;
  }
  function renderTape() {
    tapeDirty = false;
    const s = game.stream, big = (state.settings.big_lots || {})[spec.product] || 20;
    const rows = [];
    for (let k = tape.length - 1; k >= 0; k--) {
      const i = tape[k];
      const d = i > 0 ? s.P[i] - s.P[i - 1] : 0;
      rows.push(`<div class="tr ${s.Q[i] >= big ? 'big' : ''}"><span class="dim">${hms(s.T[i])}</span><span class="p ${d > 0 ? 'up' : d < 0 ? 'dn' : ''}">${fmtInt(s.P[i] + off)}</span><span class="q">${s.Q[i]}</span></div>`);
    }
    elv('tape').innerHTML = rows.join('');
  }
  function renderOrders() {
    ordersDirty = false;
    const act = game.engine.active;
    elv('ords').innerHTML = act.length ? act.map(o => {
      const px = o.type === 'LMT' ? o.price : o.type === 'STP' ? o.trig : null;
      return `<tr><td>${esc(ORD_NAME(o))}</td><td class="${o.side > 0 ? 'up' : 'dn'}">${o.side > 0 ? '買' : '賣'}</td><td class="r">${o.qty - o.filled}</td>
        <td class="r">${px == null ? '市價' : fmtInt(px + off)}</td><td class="dim">${o.status === 'pending' ? '送出中' : '掛單中'}</td>
        <td><button class="icon-btn" data-cx="${o.id}" title="取消">✕</button></td></tr>`;
    }).join('') : '<tr><td colspan="6" class="dim">沒有委託</td></tr>';
    elv('ords').querySelectorAll('[data-cx]').forEach(b => b.onclick = () => doAct('cxl', { id: +b.dataset.cx }));
  }
  function renderTrades() {
    tradesDirty = false;
    const trs = game.engine.trades;
    elv('trs').innerHTML = trs.length ? [...trs].reverse().map(t => `<tr><td>${t.seq}</td><td class="${t.dir > 0 ? 'up' : 'dn'}">${t.dir > 0 ? '多' : '空'}</td>
      <td class="r">${t.maxQty}</td><td class="r">${fmtInt(t.entryPx + off)}</td><td class="r">${fmtInt(t.exitPx + off)}</td>
      <td class="r ${upDn(t.points)}">${fmtSigned(t.points, 1)}</td><td class="r ${upDn(t.pnl)}">${fmtSigned(t.pnl)}</td></tr>`).join('')
      : '<tr><td colspan="7" class="dim">還沒有交易</td></tr>';
  }

  // ── 事件 ──
  function handleEvents(evs) {
    let lines = false;
    for (const ev of evs) {
      if (ev.type === 'fill') {
        fills.push(ev.fill);
        lines = true; ordersDirty = true;
        const f = ev.fill;
        if (f.role === 'sl') sfx.stop();
        else if (f.role === 'tp') sfx.target();
        else if (f.side > 0) sfx.buy(); else sfx.sell();
        if (f.reason === 'loss') toast('虧到單局上限,自動平倉', 'warn');
        if (f.reason === 'risk') toast('保證金不足,強制平倉', 'bad');
      } else if (ev.type === 'trade') {
        tradesDirty = true;
        const t = ev.trade;
        toast(`第 ${t.seq} 筆 ${t.dir > 0 ? '多' : '空'}單結束:${fmtSigned(t.points, 1)} 點,${fmtSigned(t.pnl)} 元`, t.pnl > 0 ? 'good' : 'bad');
      } else if (ev.type === 'reject') {
        toast('委託被拒絕:' + ev.reason, 'bad'); sfx.error(); ordersDirty = true;
      } else if (ev.type === 'margin_call') {
        toast('權益低於維持保證金(追繳)', 'warn');
      } else if (['order', 'cancel', 'modify', 'trigger'].includes(ev.type)) {
        lines = true; ordersDirty = true;
      }
    }
    if (fills.length && evs.some(e => e.type === 'fill')) refreshMarkers();
    if (lines) syncLines();
    if (game.engine.lastSeg !== lastSeg) {
      if (lastSeg >= 0 && quick) toast(game.engine.lastSeg === 1 ? '日盤收盤 → 夜盤開盤' : '開盤', 'info');
      lastSeg = game.engine.lastSeg;
    }
  }

  // ── 下單 ──
  function canTrade() {
    if (game.finished || ending) return '這一局已經結束';
    if (!started) return spec.at_open ? null : '按「開始」之後才能下單';
    if (!running && counted) return '暫停中不能下單(正式比賽)';
    return null;
  }
  function bracket() { return elv('bon').checked ? { sl: Math.max(0, +elv('bsl').value || 0), tp: Math.max(0, +elv('btp').value || 0) } : null; }
  function curQty() { const q = Math.round(+elv('qty').value); return q >= 1 ? q : 1; }
  function doAct(a, p) {
    const gate = canTrade();
    if (gate) { toast(gate, 'warn'); sfx.error(); return; }
    const r = game.act(a, p);
    if (!r.ok) { toast(r.msg, r.blocked ? 'warn' : 'bad'); sfx.error(); }
    handleEvents(game.engine.events.splice(0));
    ordersDirty = true;
    syncLines();
    refreshPanel(true);
    scheduleSave();
  }
  const market = side => doAct('mkt', { side, qty: curQty(), bracket: bracket(), tag });
  function startPick(a, side) {
    if (canTrade()) { toast(canTrade(), 'warn'); return; }
    pick = { a, side };
    const name = a === 'lmt' ? (side > 0 ? '限價買' : '限價賣') : (side > 0 ? '停損買(觸價)' : '停損賣(觸價)');
    elv('pickHint').textContent = `在圖上點價位下「${name}」(Esc 取消)`;
    elv('pickHint').classList.remove('hidden');
    chartEl.style.cursor = 'crosshair';
  }
  function endPick() { pick = null; elv('pickHint').classList.add('hidden'); chartEl.style.cursor = ''; }
  chart.onClick(price => {
    if (!pick || price == null) return;
    const { a, side } = pick;
    endPick();
    const e = game.engine;
    if (a === 'stp' && e.last != null && (side > 0 ? price <= e.last : price >= e.last)) {
      toast(side > 0 ? '停損買要掛在現價之上' : '停損賣要掛在現價之下', 'warn'); return;
    }
    doAct(a, { side, qty: curQty(), price: a === 'lmt' ? price : undefined, trig: a === 'stp' ? price : undefined, bracket: bracket(), tag });
  });

  // 拖曳委託線改價
  let drag = null;
  chartEl.addEventListener('mousedown', e => {
    if (pick || e.button !== 0) return;
    const rect = chartEl.getBoundingClientRect(), y = e.clientY - rect.top;
    let best = null;
    for (const o of game.engine.active) {
      const px = o.type === 'LMT' ? o.price : o.type === 'STP' ? o.trig : null;
      if (px == null) continue;
      const yy = chart.yOfPrice(px);
      if (yy != null && Math.abs(yy - y) <= 6 && (!best || Math.abs(yy - y) < best.d)) best = { o, d: Math.abs(yy - y), px };
    }
    if (!best) return;
    e.preventDefault(); e.stopPropagation();
    chart.setInteractive(false);
    drag = { o: best.o, from: best.px, price: null };
    const move = ev => {
      const p = chart.priceAtY(ev.clientY - rect.top);
      if (p != null && drag) { drag.price = p; chart.setLine('o' + drag.o.id, p, lineOpt(drag.o)); }
    };
    const up = () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      chart.setInteractive(true);
      const d = drag;
      drag = null;
      if (d && d.price != null && d.price !== d.from) doAct('mod', { id: d.o.id, price: d.price });
      else syncLines();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  }, true);
  chartEl.addEventListener('mousemove', e => {
    if (pick || drag) return;
    const y = e.clientY - chartEl.getBoundingClientRect().top;
    const near = game.engine.active.some(o => {
      const px = o.type === 'LMT' ? o.price : o.type === 'STP' ? o.trig : null;
      const yy = px == null ? null : chart.yOfPrice(px);
      return yy != null && Math.abs(yy - y) <= 6;
    });
    chartEl.style.cursor = near ? 'ns-resize' : '';
  });

  // ── 時間 ──
  function smartSpeed() {
    const e = game.engine;
    if (e.pos !== 0 || e.last == null) return speed;
    const near = e.active.some(o => {
      const px = o.type === 'LMT' ? o.price : o.trig;
      return px != null && Math.abs(px - e.last) <= st.move_pts * 2;
    });
    if (near) return speed;
    const p0 = game.priceAt(game.now - st.move_sec * 1000);
    if (p0 != null && Math.abs(e.last - p0) >= st.move_pts) return speed;
    return Math.max(speed, st.fast_speed);
  }
  let effSpeed = speed;
  function step(dt) {
    effSpeed = smart ? smartSpeed() : speed;
    const nu = Math.min(L, u + dt * effSpeed);
    u = nu;
    const evs = game.advance(game.clockAt(nu));
    handleEvents(evs);
    drawNewPrints();
    refreshPanel();
    if (!quick) {
      const b = $('#speeds', view);
      if (b) b.querySelectorAll('button').forEach(x => x.classList.toggle('on', +x.dataset.s === speed));
      elv('smart').textContent = smart && effSpeed > speed ? `⚡ 快轉中 ${effSpeed}×` : '⚡ 智慧快轉';
    }
    if (u >= L - 0.5) end('end');
  }
  let raf = 0, lastTs = performance.now();
  function frame(ts) {
    if (destroyed) return;
    const dt = Math.max(0, Math.min(1000, ts - lastTs));    // 瀏覽器降頻時(每秒只畫幾次)也照實際經過的時間走
    lastTs = ts;
    if (running && !ending) step(dt);
    raf = requestAnimationFrame(frame);
  }
  function onVis() { if (document.hidden && running && !ending) { setPlaying(false); toast('視窗切到背景,自動暫停', 'info'); } }
  document.addEventListener('visibilitychange', onVis);

  // ── 開始／暫停／結束 ──
  function overlay(html) {
    const o = elv('overlay');
    if (!html) { o.classList.add('hidden'); o.innerHTML = ''; return; }
    o.classList.remove('hidden');
    o.innerHTML = `<div class="box">${html}</div>`;
    const go = o.querySelector('[data-go]');
    if (go) go.onclick = () => togglePlay();
  }
  function setPlaying(on) {
    running = on;
    elv('pp').textContent = on ? '⏸ 暫停' : (started ? '▶ 繼續' : '▶ 開始');
    elv('pp2').innerHTML = (on ? '暫停' : '繼續') + '<kbd>␣</kbd>';
    if (on) overlay(null);
    else if (started && !ending) overlay(`<h2>暫停中</h2><p>${counted ? '正式比賽暫停時不能下單。' : '練習場暫停時也可以下單。'}</p><button class="btn primary lg" data-go>▶ 繼續(空白鍵)</button>`);
    refreshPanel(true);
  }
  function togglePlay() {
    if (ending) return;
    if (!started) { started = true; sfx.start(); }
    lastTs = performance.now();
    setPlaying(!running);
  }
  async function end(reason) {
    if (ending) return;
    ending = true;
    running = false;
    overlay('<h2>結算中…</h2><p>平倉、計算評分、跑 200 隻隨機猴子對照</p>');
    sfx.end();
    try {
      await settle(gid, game, c, spec, reason);
      saveTimer && clearInterval(saveTimer);
      location.hash = '#/result/' + gid;
    } catch (e) {
      ending = false;
      toast('結算失敗:' + e.message, 'bad', 6000);
      overlay(`<h2>結算失敗</h2><p>${esc(e.message)}</p><button class="btn" data-go>回到比賽</button>`);
    }
  }

  // ── 存檔(每 5 秒、每次操作後)──
  let saveDirty = false, saving = false;
  function scheduleSave() { saveDirty = true; }
  async function save(force = false) {
    if (ending || game.finished || saving || (!saveDirty && !force)) return;
    saving = true; saveDirty = false;
    try { await api.post(`/api/game/${gid}/autosave`, { orders: game.log, saved_t: game.now }); } catch (e) { saveDirty = true; }
    saving = false;
  }
  const saveTimer = setInterval(() => { if (running) saveDirty = true; save(); }, 5000);
  function saveNow() {
    if (ending || game.finished) return;
    try {
      fetch(`/api/game/${gid}/autosave`, { method: 'POST', keepalive: true, headers: { 'X-Arena': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: game.log, saved_t: game.now }) });
    } catch (e) { /* 關閉中 */ }
  }
  window.addEventListener('beforeunload', saveNow);

  // ── 練習場倒帶 ──
  function rewind(ms) {
    const target = Math.max(game.start, game.clockAt(Math.max(0, u - ms)));
    const keep = game.log.filter(x => x.t <= target);
    game = new Game(spec, c, bins);
    game.replay(keep, target);
    u = game.tradingElapsed(game.now);
    fills.length = 0;
    fills.push(...game.engine.fills);
    tape.length = 0;
    lastSeg = game.engine.lastSeg;
    rebuildChart();
    syncLines();
    ordersDirty = tradesDirty = true;
    refreshPanel(true);
    toast('倒帶 5 分鐘(之後的操作已取消)', 'info');
  }

  // ── 按鈕與快速鍵 ──
  elv('buy').onclick = () => market(1);
  elv('sell').onclick = () => market(-1);
  elv('lb').onclick = () => startPick('lmt', 1);
  elv('ls').onclick = () => startPick('lmt', -1);
  elv('sb').onclick = () => startPick('stp', 1);
  elv('ss').onclick = () => startPick('stp', -1);
  elv('flat').onclick = () => doAct('flat', {});
  elv('rev').onclick = () => doAct('rev', { bracket: bracket(), tag });
  elv('cxa').onclick = () => doAct('cxa', {});
  elv('pp').onclick = togglePlay;
  elv('pp2').onclick = togglePlay;
  elv('qm').onclick = () => { elv('qty').value = Math.max(1, curQty() - 1); };
  elv('qp').onclick = () => { elv('qty').value = curQty() + 1; };
  const saveBr = () => { try { localStorage.setItem('arena.bracket.' + c.id, JSON.stringify({ on: elv('bon').checked, sl: +elv('bsl').value, tp: +elv('btp').value })); } catch (e) { /* 無痕 */ } };
  ['bon', 'bsl', 'btp'].forEach(id => elv(id).addEventListener('change', saveBr));
  if (elv('tag')) elv('tag').onchange = () => { tag = elv('tag').value || null; };
  elv('quit').onclick = async () => {
    const msg = counted ? '提前結束?剩下的時間不再交易,部位用現價平倉,這一局照樣計入戰績。' : '結束這一局練習?';
    const wasRunning = running;
    if (wasRunning) setPlaying(false);
    if (await confirmBox('結束這一局', msg, '結束並結算', 'danger')) end('quit');
    else if (wasRunning) setPlaying(true);
  };
  elv('back').onclick = () => { save(true); location.hash = '#/'; };
  if (!quick) {
    $('#speeds', view).querySelectorAll('button').forEach(b => b.onclick = () => { speed = +b.dataset.s; refreshPanel(true); step(0); });
    elv('smart').onclick = () => { smart = !smart; elv('smart').classList.toggle('primary', smart); };
  }
  if (elv('rew')) elv('rew').onclick = () => rewind(5 * 60000);
  $('#tfs', view).querySelectorAll('button').forEach(b => b.onclick = () => setTf(+b.dataset.tf));
  function setTf(v) { tf = v; $('#tfs', view).querySelectorAll('button').forEach(x => x.classList.toggle('on', +x.dataset.tf === tf)); rebuildChart(); }
  elv('recent').onclick = () => chart.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, barCount - (tf === 1 ? 150 : 90)), to: barCount + 8 });

  function onKey(e) {
    if (e.target.closest('input, select, textarea') || document.querySelector('.modal-wrap')) return;
    const k = e.key.toLowerCase();
    const map = {
      ' ': togglePlay, b: () => market(1), s: () => market(-1), f: () => doAct('flat', {}), r: () => doAct('rev', { bracket: bracket(), tag }),
      c: () => doAct('cxa', {}), q: () => startPick('lmt', 1), w: () => startPick('lmt', -1), a: () => startPick('stp', 1), z: () => startPick('stp', -1),
      escape: endPick, '1': () => setTf(1), '2': () => setTf(5), '3': () => setTf(15),
      '+': () => { elv('qty').value = curQty() + 1; }, '=': () => { elv('qty').value = curQty() + 1; }, '-': () => { elv('qty').value = Math.max(1, curQty() - 1); },
      arrowup: () => { if (!quick) { const i = SPEEDS.indexOf(speed); speed = SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]; refreshPanel(true); step(0); } },
      arrowdown: () => { if (!quick) { const i = SPEEDS.indexOf(speed); speed = SPEEDS[Math.max(0, i - 1)]; refreshPanel(true); step(0); } },
    };
    if (map[k]) { e.preventDefault(); map[k](); }
  }
  window.addEventListener('keydown', onKey);

  // ── 開場 ──
  rebuildChart();
  setTf(tf);
  for (let i = Math.max(game.firstIdx, game.engine.i - 40); i < game.engine.i; i++) tape.push(i);   // 續玩:最近的成交明細
  fills.push(...game.engine.fills);
  refreshMarkers();
  syncLines();
  refreshPanel(true);
  const rl = [];
  if (rules.maxLoss) rl.push(`單局最多虧 ${fmtInt(rules.maxLoss)} 元`);
  if (rules.maxTrades) rl.push(`最多 ${rules.maxTrades} 筆`);
  if (rules.requireStop) rl.push('進場一定帶停損');
  if (rules.maxLots) rl.push(`每筆最多 ${rules.maxLots} 口`);
  const intro = resumed
    ? `<h2>繼續上一局</h2><p>上次玩到 ${hms(game.now)},部位與委託都已還原。</p>`
    : `<h2>${esc(title)}</h2><p>${esc(where)}${quick ? '<br>5 分鐘走完一整個日盤和夜盤,約 ' + Math.round(speed) + ' 倍速。' : ''}
       ${spec.at_open ? '<br>開盤前可以先下單,參加開盤集合競價。' : ''}${rl.length ? '<br>規則:' + esc(rl.join('、')) : ''}</p>`;
  overlay(`${intro}<button class="btn primary lg" data-go>▶ ${resumed ? '繼續' : '開始'}(空白鍵)</button>`);
  if (resumed) {
    started = true;
    elv('pp').textContent = '▶ 繼續';
    elv('pp2').innerHTML = '繼續<kbd>␣</kbd>';
  }
  if (new URLSearchParams(location.search).has('shot')) overlay(null);       // 說明書截圖用:不蓋開場說明
  raf = requestAnimationFrame(frame);

  return {
    destroy: async () => {
      destroyed = true;
      cancelAnimationFrame(raf);
      clearInterval(saveTimer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', saveNow);
      document.removeEventListener('visibilitychange', onVis);
      if (!ending && !game.finished) { saveDirty = true; await save(true); }
      chart.remove();
    },
  };
}
