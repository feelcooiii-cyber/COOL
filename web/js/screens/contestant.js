// 參賽者:戰績分析頁、新增／編輯
import { api } from '../api.js';
import { ACH, breakdown, coach, contestantStats, FORMAT_NAME, gameBeat, MODE_NAME, RANKS } from '../stats.js';
import { avatar, confirmBox, rankBadge, toast } from '../ui.js';
import { COLORS, $, dur, esc, fmtInt, fmtNum, fmtPct, fmtSigned, upDn, weekday } from '../util.js';
import { invalidate, loadOverview, prod, state } from '../state.js';
import { monkeyFlow, startFlow } from './start.js';
import { achCard } from './result.js';

const EXIT = { sl: '停損', tp: '停利', manual: '手動', end: '收盤平倉', quit: '提前結束', loss: '虧損上限', risk: '保證金不足' };

export async function contestantScreen(view, idStr) {
  const id = +idStr;
  const [c, ov] = await Promise.all([api.get('/api/contestant/' + id), loadOverview(true)]);
  const P = prod(c.product), mult = P.mult;
  const S = contestantStats(c, ov, { mult });
  const st = S.st, trades = S.trades;
  const human = c.kind === 'human';
  const have = new Set(ov.achievements.filter(a => a.contestant_id === c.id).map(a => a.code));
  const allGames = ov.games.filter(g => g.contestant_id === c.id).sort((a, b) => b.id - a.id);
  const verdict = makeVerdict(S, human);
  const bd = (title, rows, label) => rows.length ? `<div class="card"><h4 style="margin-bottom:6px">${esc(title)}</h4><table class="t"><thead><tr><th></th><th class="r">筆數</th><th class="r">勝率</th><th class="r">期望值(元)</th><th class="r">點/口</th><th class="r">總損益</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="${r.n < 10 ? 'dimrow' : ''}"><td>${esc(label ? label(r.key) : r.key)}</td><td class="r">${r.n}</td><td class="r">${fmtPct(r.winRate)}</td>
      <td class="r ${upDn(r.exp)}">${fmtSigned(r.exp)}</td><td class="r ${upDn(r.expPts)}">${fmtSigned(r.expPts, 1)}</td><td class="r ${upDn(r.total)}">${fmtSigned(r.total)}</td></tr>`).join('')}</tbody></table></div>` : '';
  const holdBucket = t => t.hold < 300 ? '5 分鐘內' : t.hold < 900 ? '5–15 分鐘' : t.hold < 3600 ? '15–60 分鐘' : '1 小時以上';
  const coachList = coach(trades, mult);

  view.innerHTML = `
  <div class="page-head">${avatar(c, 56)}<div><h1>${esc(c.name)}</h1>
    <div class="note">${human ? '真人操作' : '電腦 · 隨機猴子'} · ${esc(P.name)} · 起始資金 ${fmtInt(c.capital)} · 手續費每口每邊 ${fmtInt(c.commission)} 元</div></div>
    ${human ? rankBadge(S.rank) : '<span class="rank r-rookie">對照組</span>'}<span class="spacer"></span>
    <button class="btn primary" id="go">${human ? '開始比賽' : '下場跑'}</button>
    <button class="btn" id="edit">編輯</button><button class="btn" id="copy">複製</button><button class="btn ghost" id="arch">封存</button></div>
  ${human ? `<div class="verdict ${verdict.cls}"><b>${esc(verdict.title)}</b><div class="note" style="margin-top:4px">${verdict.text}</div></div>` : ''}
  <div class="mcards section">
    ${mc('正式交易', fmtInt(st.n) + ' 筆', `${S.games.length} 局`)}
    ${mc('勝率', fmtPct(st.winRate), st.n ? `${st.wins} 勝 ${st.n - st.wins} 敗` : '')}
    ${mc('風報比', st.payoff == null ? '—' : fmtNum(st.payoff, 2), '平均賺 ÷ 平均賠')}
    ${mc('期望值', fmtSigned(st.exp), `元/筆 · ${fmtSigned(st.expPts, 1)} 點/口`, upDn(st.exp))}
    ${mc('獲利因子', st.pf == null ? '—' : st.pf === Infinity ? '∞' : fmtNum(st.pf, 2), '總賺 ÷ 總賠')}
    ${mc('總損益', fmtSigned(st.total), '元(扣成本)', upDn(st.total))}
    ${mc('最大回撤', fmtInt(st.maxDD), '元(依出場順序)', 'dn')}
    ${mc('最長連虧', st.n ? st.maxLoseStreak + ' 筆' : '—', '')}
    ${mc('平均持有', st.avgHold == null ? '—' : dur(st.avgHold * 1000), '')}
    ${mc('平均 R', st.avgR == null ? '—' : fmtNum(st.avgR, 2), st.nR ? `${st.nR} 筆有停損可算` : '沒有停損就算不出 R')}
    ${mc('出場效率', st.eff == null ? '—' : fmtPct(st.eff), '獲利單拿到最大有利的比例')}
    ${mc('總成本', fmtInt(st.costs), '手續費＋期交稅')}
    ${human ? mc('贏過隨機猴子', S.beat == null ? '—' : fmtPct(S.beat), '同樣筆數、持有時間,隨機進場') : ''}
  </div>
  ${trades.length >= 2 ? `<div class="section grid cols-2">
    <div class="card"><h4>累積損益(依交易順序)</h4>${svgEquity(trades)}</div>
    <div class="card"><h4>每筆損益分佈(${st.nR >= 5 ? 'R 倍數' : '點/口'})</h4>${svgHist(st.nR >= 5 ? trades.filter(t => t.r != null).map(t => t.r) : trades.map(t => t.pnl / mult / Math.max(1, t.qty)), st.nR >= 5 ? 'R' : '點')}</div></div>` : ''}
  ${coachList.length ? `<div class="section"><h3>教練講評</h3><div class="card"><ul class="coach" style="margin:0;padding-left:18px">${coachList.map(x => `<li class="${x.level}">${esc(x.text)} <span class="dim">(樣本 ${x.n})</span></li>`).join('')}</ul></div></div>` : ''}
  ${trades.length ? `<div class="section"><h3>分組(灰色 = 不到 10 筆,先別下結論)</h3><div class="grid cols-2">
    ${bd('多空', breakdown(trades, t => (t.dir > 0 ? '做多' : '做空'), mult))}
    ${bd('日盤／夜盤', breakdown(trades, t => (t.kind === 'D' ? '日盤' : '夜盤'), mult))}
    ${bd('賽制', breakdown(trades, t => FORMAT_NAME[t.format] || t.format, mult))}
    ${bd('進場時段', breakdown(trades, t => t.hour, mult, [...Array(24).keys()].map(h => (h + 8) % 24)), k => `${String(k).padStart(2, '0')}:00–${String((k + 1) % 24).padStart(2, '0')}:00`)}
    ${bd('持有時間', breakdown(trades, holdBucket, mult, ['5 分鐘內', '5–15 分鐘', '15–60 分鐘', '1 小時以上']))}
    ${bd('出場方式', breakdown(trades, t => EXIT[(t.flags || {}).exitBy] || '其他', mult))}
    ${bd('進場理由', breakdown(trades, t => t.tag || '(沒選)', mult))}
    ${bd('有沒有照策略', breakdown(trades, t => (t.followed === 1 ? '照策略' : t.followed === 0 ? '沒照策略' : '(沒填)'), mult))}
    ${bd('情境關卡', breakdown(trades.filter(t => t.scenario), t => t.scenario, mult))}
    ${bd('追價', breakdown(trades, t => ((t.flags || {}).chased ? '追價進場' : '沒追價'), mult))}
  </div></div>` : ''}
  ${human ? `<div class="section"><h3>成就(${have.size}/${Object.keys(ACH).length})</h3><div class="ach-grid">${Object.keys(ACH).map(k => achCard(k, false, !have.has(k))).join('')}</div></div>` : ''}
  ${human && c.strategy ? `<div class="section grid cols-2"><div class="card"><h4>策略卡</h4>
    ${['entry', 'exit', 'stop', 'size'].map(k => c.strategy[k] ? `<p style="margin:6px 0"><b>${({ entry: '進場', exit: '出場', stop: '停損', size: '部位' })[k]}</b> ${esc(c.strategy[k])}</p>` : '').join('') || '<p class="note">還沒寫策略</p>'}</div>
    <div class="card"><h4>規則</h4>${rulesText(c.rules).map(x => `<p style="margin:6px 0">• ${esc(x)}</p>`).join('') || '<p class="note">沒有設定規則</p>'}</div></div>` : ''}
  <div class="section"><h3>比賽紀錄</h3><div class="card" style="overflow:auto"><table class="t big"><thead><tr><th>#</th><th>模式</th><th>賽制</th><th>行情</th><th class="r">筆數</th><th class="r">損益</th><th>評分</th><th class="r">贏過猴子</th></tr></thead>
    <tbody>${allGames.map(g => { const s = g.summary || {}; const b = gameBeat(g.monkey, s.pnl); return `<tr class="click" data-g="${g.id}"><td>${g.id}</td><td>${esc(MODE_NAME[g.mode] || '')}</td><td>${esc(FORMAT_NAME[g.format] || '')}${g.scenario ? ' · ' + esc(g.scenario) : ''}</td>
      <td>${esc(s.date || '')}${s.date ? `(${weekday(s.date)})` : ''} ${esc(g.format === 'quick' ? '日盤＋夜盤' : (s.label || ''))}</td><td class="r">${s.n ?? 0}</td><td class="r ${upDn(s.pnl)}">${fmtSigned(s.pnl)}</td>
      <td><span class="grade ${s.grade && s.grade.length === 1 ? s.grade : 'x'}">${esc(s.grade || '—')}</span></td><td class="r">${b == null ? '—' : fmtPct(b)}</td></tr>`; }).join('') || '<tr><td colspan="8" class="dim">還沒有比賽</td></tr>'}</tbody></table></div></div>`;

  $('#go', view).onclick = async () => { if (human) await startFlow(c); else await monkeyFlow(c, () => contestantScreen(view, id)); };
  $('#edit', view).onclick = () => { location.hash = '#/edit/' + c.id; };
  $('#copy', view).onclick = () => { location.hash = '#/copy/' + c.id; };
  $('#arch', view).onclick = async () => {
    if (!await confirmBox('封存參賽者', `封存「${c.name}」?封存後大廳和排行榜不再顯示,比賽紀錄保留在資料庫。`, '封存', 'danger')) return;
    await api.post(`/api/contestant/${c.id}/archive`);
    invalidate();
    location.hash = '#/';
  };
  view.querySelectorAll('tr[data-g]').forEach(tr => tr.onclick = () => { location.hash = '#/result/' + tr.dataset.g; });
  if (human && new URLSearchParams(location.search).get('shot') === 'pick') startFlow(c);   // 說明書截圖用
}

function mc(k, v, s = '', cls = '') { return `<div class="mcard"><div class="k">${esc(k)}</div><div class="v ${cls}">${v}</div><div class="s">${esc(s)}</div></div>`; }

function makeVerdict(S, human) {
  const n = S.st.n || 0;
  if (!human) return { cls: '', title: '', text: '' };
  if (n < 30) return { cls: '', title: `樣本還不夠:目前 ${n} 筆正式交易`, text: '至少 30 筆才開始判斷;一兩局的輸贏多半是運氣。' };
  const ci = S.ci, beat = S.beat;
  const ciTxt = ci ? `期望值 95% 區間 ${fmtSigned(ci.lo)} ~ ${fmtSigned(ci.hi)} 元/筆` : '';
  const beatTxt = beat == null ? '' : `,贏過 ${fmtPct(beat)} 的隨機猴子`;
  if (ci && ci.lo > 0 && beat != null && beat >= 0.95) return { cls: 'good', title: '有統計上的優勢', text: `${ciTxt}${beatTxt}。整個區間都大於 0,而且明顯贏過隨機進場。` };
  if (ci && ci.hi < 0) return { cls: 'bad', title: '目前是虧錢的策略', text: `${ciTxt}${beatTxt}。整個區間都小於 0。` };
  const need = S.need ? `照目前的波動,大約要 ${fmtInt(S.need)} 筆才判斷得出來(還差 ${fmtInt(Math.max(0, S.need - n))} 筆)。` : '目前期望值不是正的,先檢討再累積。';
  return { cls: '', title: '還不能下結論', text: `${ciTxt}${beatTxt}。${need}` };
}

export function rulesText(r = {}) {
  const out = [];
  if (r.maxLots) out.push(`每筆最多 ${r.maxLots} 口`);
  if (r.maxLoss) out.push(`單局最多虧 ${fmtInt(r.maxLoss)} 元(到了自動平倉並鎖單)`);
  if (r.requireStop) out.push('進場一定要帶停損');
  if (r.maxTrades) out.push(`每局最多 ${r.maxTrades} 筆`);
  if (r.cooldown && r.cooldown.losses) out.push(`連虧 ${r.cooldown.losses} 筆冷靜 ${r.cooldown.minutes || 5} 分鐘`);
  if (r.maxDD) out.push(`最大回撤上限 ${fmtInt(r.maxDD)} 元(鑽石段位條件)`);
  return out;
}

function svgEquity(trades) {
  const ord = [...trades].sort((a, b) => a.exit_t - b.exit_t);
  let cum = 0;
  const ys = [0, ...ord.map(t => (cum += t.pnl))];
  const W = 600, H = 180, pad = 6;
  const lo = Math.min(0, ...ys), hi = Math.max(0, ...ys), rng = hi - lo || 1;
  const x = i => pad + (W - 2 * pad) * i / (ys.length - 1), y = v => pad + (H - 2 * pad) * (hi - v) / rng;
  const pts = ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const end = ys[ys.length - 1];
  return `<svg class="svgchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:180px">
    <line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#344057" stroke-dasharray="4 3"/>
    <polyline points="${pts}" fill="none" stroke="${end >= 0 ? '#ff6b6d' : '#33d68a'}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <div class="note">最後 ${fmtSigned(end)} 元 · 最高 ${fmtSigned(hi)} · 最低 ${fmtSigned(lo)}</div>`;
}

function svgHist(vals, unit) {
  if (!vals.length) return '<p class="note">沒有資料</p>';
  const lo = Math.floor(Math.min(...vals)), hi = Math.ceil(Math.max(...vals));
  const nb = Math.min(24, Math.max(6, Math.round(Math.sqrt(vals.length) * 2)));
  const w = (hi - lo) / nb || 1;
  const bins = new Array(nb).fill(0);
  for (const v of vals) bins[Math.min(nb - 1, Math.floor((v - lo) / w))]++;
  const W = 600, H = 170, mx = Math.max(...bins);
  const bw = W / nb;
  const bars = bins.map((b, i) => {
    const h = (H - 20) * b / mx, x0 = lo + i * w;
    return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - 18 - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="${x0 + w / 2 >= 0 ? 'rgba(255,77,79,.7)' : 'rgba(31,191,117,.7)'}"><title>${fmtNum(x0, 1)} ~ ${fmtNum(x0 + w, 1)} ${unit}:${b} 筆</title></rect>`;
  }).join('');
  return `<svg class="svgchart" viewBox="0 0 ${W} ${H}" style="height:170px">${bars}
    <text x="2" y="${H - 4}" fill="#6c7589" font-size="11">${fmtNum(lo, 1)} ${unit}</text><text x="${W - 2}" y="${H - 4}" fill="#6c7589" font-size="11" text-anchor="end">${fmtNum(hi, 1)} ${unit}</text></svg>`;
}

// ── 新增／編輯 ──
export async function editorScreen(view, idStr, copy = false) {
  const editing = idStr ? await api.get('/api/contestant/' + idStr) : null;
  const ov = editing && !copy ? await loadOverview(true) : null;
  const played = editing && !copy ? ov.games.some(g => g.contestant_id === editing.id) || ov.contestants.length < 0 : false;
  const c = editing ? JSON.parse(JSON.stringify(editing)) : {
    name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)], kind: 'human', product: 'MTX', capital: 1000000, commission: 0,
    rules: { maxLots: 5, maxLoss: 20000, requireStop: true, maxTrades: 10, cooldown: { losses: 3, minutes: 10 } },
    strategy: {}, tags: ['突破', '回檔', '反轉', '跳空'], monkey: { trades: 5, holdMin: 15, qty: 1, sl: 0, tp: 0 },
  };
  if (copy) { c.name = c.name + '(複製)'; delete c.id; }
  c.rules = c.rules || {}; c.strategy = c.strategy || {}; c.monkey = c.monkey || {}; c.rules.cooldown = c.rules.cooldown || {};
  const prods = (state.status.product_order || ['MTX', 'TX', 'TMF']);
  view.innerHTML = `
  <div class="page-head"><h1>${editing && !copy ? '編輯參賽者' : copy ? '複製參賽者' : '新增參賽者'}</h1><span class="spacer"></span>
    <button class="btn" id="cancel">取消</button><button class="btn primary" id="save">儲存</button></div>
  <div class="grid cols-2">
    <fieldset><legend>基本</legend><div class="form">
      <label>名字</label><input type="text" id="name" maxlength="20" value="${esc(c.name)}" placeholder="突破小王">
      <label>顏色</label><div class="colors" id="colors">${COLORS.map(x => `<span class="sw ${x === c.color ? 'on' : ''}" data-c="${x}" style="background:${x}"></span>`).join('')}</div>
      <label>類型</label><div class="seg" id="kind"><button data-k="human">自己操作</button><button data-k="monkey">電腦隨機猴子</button></div>
      <label>商品</label><div class="seg" id="prod">${prods.map(p => `<button data-p="${p}">${esc(prod(p).name)}(每點 ${prod(p).mult} 元)</button>`).join('')}</div>
      <label>起始資金</label><div class="row"><input type="number" id="capital" min="100000" step="100000" value="${c.capital}" style="width:140px"><span class="note">元</span></div>
      <label>手續費</label><div class="row"><input type="number" id="commission" min="0" step="1" value="${c.commission}"><span class="note">元/口/邊(期交稅另外自動算)</span></div>
      ${played ? '<div class="full note">這位參賽者已經比賽過,類型和商品不能改(戰績會混在一起);要換請用「複製」。</div>' : ''}
    </div></fieldset>
    <fieldset id="humanBox"><legend>規則(比賽中強制執行;0 = 不限制)</legend><div class="form">
      <label>每筆最多</label><div class="row"><input type="number" id="maxLots" min="0" value="${c.rules.maxLots || 0}"><span class="note">口</span></div>
      <label>單局最多虧</label><div class="row"><input type="number" id="maxLoss" min="0" step="1000" value="${c.rules.maxLoss || 0}" style="width:120px"><span class="note">元,到了自動平倉並鎖住新單</span></div>
      <label>每局最多</label><div class="row"><input type="number" id="maxTrades" min="0" value="${c.rules.maxTrades || 0}"><span class="note">筆</span></div>
      <label>連虧冷靜</label><div class="row">連虧 <input type="number" id="cdL" min="0" value="${c.rules.cooldown.losses || 0}" style="width:60px"> 筆,冷靜 <input type="number" id="cdM" min="0" value="${c.rules.cooldown.minutes || 0}" style="width:60px"> 分鐘(市場時間)</div>
      <label>停損</label><label class="chk"><input type="checkbox" id="reqStop" ${c.rules.requireStop ? 'checked' : ''}> 進場一定要帶停損</label>
      <label>最大回撤上限</label><div class="row"><input type="number" id="maxDD" min="0" step="10000" value="${c.rules.maxDD || 0}" style="width:120px"><span class="note">元,鑽石段位的條件(0 = 起始資金的 20%)</span></div>
    </div></fieldset>
    <fieldset id="monkeyBox"><legend>猴子的行為(每一局)</legend><div class="form">
      <label>交易筆數</label><div class="row"><input type="number" id="mT" min="1" value="${c.monkey.trades || 5}"><span class="note">筆(隨機時間進場、隨機多空)</span></div>
      <label>平均持有</label><div class="row"><input type="number" id="mH" min="1" value="${c.monkey.holdMin || 15}"><span class="note">分鐘(指數分佈,有長有短)</span></div>
      <label>口數</label><input type="number" id="mQ" min="1" value="${c.monkey.qty || 1}">
      <label>停損／停利</label><div class="row"><input type="number" id="mSL" min="0" value="${c.monkey.sl || 0}"> / <input type="number" id="mTP" min="0" value="${c.monkey.tp || 0}"><span class="note">點(0 = 不掛)</span></div>
      <div class="full note">猴子是「沒有任何判斷」的對照組:你的策略至少要穩定贏過它,才算真的有東西。</div>
    </div></fieldset>
    <fieldset id="stratBox" class="full"><legend>策略卡(比賽時顯示在旁邊提醒自己)</legend><div class="form">
      <label>進場條件</label><textarea id="sEntry" rows="2" placeholder="例:5 分 K 突破開盤 15 分鐘高點,量放大">${esc(c.strategy.entry || '')}</textarea>
      <label>出場條件</label><textarea id="sExit" rows="2" placeholder="例:跌破 5 分 K 前低或賺 2R">${esc(c.strategy.exit || '')}</textarea>
      <label>停損方式</label><textarea id="sStop" rows="2" placeholder="例:進場後固定 40 點">${esc(c.strategy.stop || '')}</textarea>
      <label>部位大小</label><textarea id="sSize" rows="2" placeholder="例:每筆 2 口,不加碼">${esc(c.strategy.size || '')}</textarea>
      <label>進場理由標籤</label><input type="text" id="tags" value="${esc((c.tags || []).join('、'))}" placeholder="用頓號或逗號分開,例:突破、回檔、跳空">
    </div></fieldset>
  </div>`;
  let kind = c.kind, product = c.product, color = c.color;
  const setKind = k => {
    kind = k;
    view.querySelectorAll('#kind button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    $('#humanBox', view).classList.toggle('hidden', k !== 'human');
    $('#stratBox', view).classList.toggle('hidden', k !== 'human');
    $('#monkeyBox', view).classList.toggle('hidden', k !== 'monkey');
    if (k === 'monkey' && !$('#name', view).value) $('#name', view).value = '隨機猴子';
  };
  const setProd = p => { product = p; view.querySelectorAll('#prod button').forEach(b => b.classList.toggle('on', b.dataset.p === p)); };
  setKind(kind); setProd(product);
  if (!played) {
    view.querySelectorAll('#kind button').forEach(b => b.onclick = () => setKind(b.dataset.k));
    view.querySelectorAll('#prod button').forEach(b => b.onclick = () => setProd(b.dataset.p));
  }
  view.querySelectorAll('#colors .sw').forEach(s => s.onclick = () => { color = s.dataset.c; view.querySelectorAll('#colors .sw').forEach(x => x.classList.toggle('on', x === s)); });
  $('#cancel', view).onclick = () => history.back();
  $('#save', view).onclick = async () => {
    const v = id => $('#' + id, view).value;
    const num = id => Math.max(0, Number(v(id)) || 0);
    const body = {
      name: v('name').trim(), color, kind, product, capital: Math.max(100000, num('capital')), commission: num('commission'),
      rules: { maxLots: num('maxLots'), maxLoss: num('maxLoss'), maxTrades: num('maxTrades'), requireStop: $('#reqStop', view).checked,
        cooldown: { losses: num('cdL'), minutes: num('cdM') }, maxDD: num('maxDD') },
      strategy: { entry: v('sEntry').trim(), exit: v('sExit').trim(), stop: v('sStop').trim(), size: v('sSize').trim() },
      tags: v('tags').split(/[、,,\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 20),
      monkey: { trades: Math.max(1, num('mT')), holdMin: Math.max(1, num('mH')), qty: Math.max(1, num('mQ')), sl: num('mSL'), tp: num('mTP') },
    };
    if (!body.name) { toast('請輸入名字', 'warn'); return; }
    try {
      const r = editing && !copy ? await api.post('/api/contestant/' + editing.id, body) : await api.post('/api/contestants', body);
      invalidate();
      toast('已儲存', 'good');
      location.hash = '#/c/' + r.id;
    } catch (e) { toast(e.message, 'bad', 5000); }
  };
}

export { RANKS };
