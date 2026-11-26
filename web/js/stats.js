// 戰績統計:勝率、風報比、期望值…;用隨機猴子判斷是不是真的有優勢;段位、成就、教練講評
import { mean, median, rng, sd, sum, quantile, fmtInt, fmtPct, dur } from './util.js';

export const MODE_NAME = { ranked: '正式賽', scenario: '情境關卡', practice: '練習場' };
export const FORMAT_NAME = { hour: '一小時局', session: '整盤', quick: '快速局' };
export const COUNTED = new Set(['ranked', 'scenario']);        // 計入戰績的模式

export function netPts(t, mult) { return t.pnl / mult / Math.max(1, t.qty); }

export function summarize(trades, mult = 50) {
  const n = trades.length;
  const out = { n };
  if (!n) return out;
  const pnl = trades.map(t => t.pnl);
  const win = trades.filter(t => t.pnl > 0), loss = trades.filter(t => t.pnl <= 0);
  out.wins = win.length;
  out.winRate = win.length / n;
  out.avgWin = win.length ? mean(win.map(t => t.pnl)) : null;
  out.avgLoss = loss.length ? mean(loss.map(t => t.pnl)) : null;
  out.payoff = out.avgWin != null && out.avgLoss ? out.avgWin / Math.abs(out.avgLoss) : null;
  out.exp = mean(pnl);
  out.expPts = mean(trades.map(t => netPts(t, mult)));
  const gw = sum(win.map(t => t.pnl)), gl = Math.abs(sum(loss.map(t => t.pnl)));
  out.pf = gl > 0 ? gw / gl : (gw > 0 ? Infinity : null);
  out.total = sum(pnl);
  const ordered = [...trades].sort((a, b) => a.exit_t - b.exit_t);
  let cum = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const t of ordered) {
    cum += t.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
    if (t.pnl <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0;
  }
  out.maxDD = dd;
  out.maxLoseStreak = worst;
  out.avgHold = mean(trades.map(t => t.hold));
  const rs = trades.filter(t => t.r != null).map(t => t.r);
  out.avgR = rs.length ? mean(rs) : null;
  out.nR = rs.length;
  const effs = win.filter(t => t.eff != null).map(t => t.eff);
  out.eff = effs.length ? mean(effs) : null;
  out.costs = sum(trades.map(t => t.costs || 0));
  out.longShare = trades.filter(t => t.dir > 0).length / n;
  return out;
}

export function bootstrapMean(values, B = 2000, seed = 7) {
  if (values.length < 2) return null;
  const r = rng(seed), n = values.length, ms = new Float64Array(B);
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += values[(r() * n) | 0];
    ms[b] = s / n;
  }
  ms.sort();
  return { lo: quantile(ms, 0.025), hi: quantile(ms, 0.975) };
}

// 期望值要多少筆,95% 區間下限才會大於 0(用目前的平均與標準差估)
export function needTrades(values) {
  const m = mean(values), s = sd(values);
  if (m == null || s == null || m <= 0) return null;
  return Math.ceil((1.96 * s / m) ** 2);
}

// 每一局的猴子總損益陣列 → 隨機各抽一個加總,重複 B 次;回傳「你的總損益贏過幾成」
export function monkeyBeat(games, humanTotal, B = 2000, seed = 11) {
  const arrs = games.map(g => g.monkey || []).filter(a => a.length);
  if (!arrs.length) return null;
  const r = rng(seed);
  let below = 0;
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (const a of arrs) s += a[(r() * a.length) | 0];
    if (s < humanTotal) below++;
    else if (s === humanTotal) below += 0.5;
  }
  return below / B;
}
export function gameBeat(monkey, pnl) {
  if (!monkey || !monkey.length) return null;
  let below = 0;
  for (const x of monkey) { if (x < pnl) below++; else if (x === pnl) below += 0.5; }
  return below / monkey.length;
}

export const RANKS = [
  { code: 'rookie', name: '新手', need: '正式交易累積 30 筆' },
  { code: 'bronze', name: '青銅', need: '期望值(扣成本)大於 0' },
  { code: 'silver', name: '白銀', need: '50 筆以上,贏過 80% 的隨機猴子' },
  { code: 'gold', name: '黃金', need: '100 筆以上,贏過 95% 的隨機猴子' },
  { code: 'plat', name: '白金', need: '200 筆以上,贏過 99%,最大回撤在上限內' },
  { code: 'diamond', name: '鑽石', need: '最高段位' },
];
export function rankOf(st, beat, ddLimit) {
  const n = st.n || 0;
  let k = 0;
  if (n >= 30) k = 1;
  if (n >= 30 && st.exp > 0) k = 2;
  if (n >= 50 && st.exp > 0 && beat != null && beat >= 0.8) k = 3;
  if (n >= 100 && st.exp > 0 && beat != null && beat >= 0.95) k = 4;
  if (n >= 200 && st.exp > 0 && beat != null && beat >= 0.99 && (ddLimit == null || st.maxDD <= ddLimit)) k = 5;
  return { ...RANKS[k], level: k, next: RANKS[k].need };
}

export function contestantStats(c, overview, opt = {}) {
  const mult = opt.mult || 50;
  const games = overview.games.filter(g => g.contestant_id === c.id && COUNTED.has(g.mode));
  const gids = new Set(games.map(g => g.id));
  const trades = overview.trades.filter(t => gids.has(t.game_id));
  const st = summarize(trades, mult);
  const beat = trades.length ? monkeyBeat(games, st.total) : null;
  const ci = bootstrapMean(trades.map(t => t.pnl));
  const need = needTrades(trades.map(t => t.pnl));
  const ddLimit = c.rules && c.rules.maxDD ? c.rules.maxDD : c.capital * 0.2;
  const rank = rankOf(st, beat, ddLimit);
  return { games, trades, st, beat, ci, need, rank };
}

export function breakdown(trades, keyFn, mult, order) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  let keys = [...groups.keys()];
  if (order) keys = order.filter(k => groups.has(k)).concat(keys.filter(k => !order.includes(k)));
  return keys.map(k => {
    const g = groups.get(k);
    const s = summarize(g, mult);
    return { key: k, n: g.length, winRate: s.winRate, exp: s.exp, expPts: s.expPts, total: s.total, payoff: s.payoff };
  });
}

// 教練講評:只講有足夠樣本的,每一條都附數字
export function coach(trades, mult) {
  const out = [];
  const W = trades.filter(t => t.pnl > 0), L = trades.filter(t => t.pnl <= 0);
  if (W.length >= 5 && L.length >= 5) {
    const hw = median(W.map(t => t.hold)), hl = median(L.map(t => t.hold));
    if (hl >= hw * 1.5) out.push({ level: 'warn', text: `虧損單持有時間中位數 ${dur(hl * 1000)},獲利單只有 ${dur(hw * 1000)}:典型的「抱虧砍賺」。`, n: trades.length });
    else if (hw >= hl * 1.5) out.push({ level: 'good', text: `獲利單抱得比虧損單久(中位數 ${dur(hw * 1000)} 對 ${dur(hl * 1000)}),讓獲利跑、虧損快砍。`, n: trades.length });
  }
  const effs = W.filter(t => t.eff != null).map(t => t.eff);
  if (effs.length >= 5) {
    const m = mean(effs);
    if (m < 0.4) out.push({ level: 'warn', text: `獲利單平均只拿到持有期間最大有利的 ${Math.round(m * 100)}%,出場可能太早。`, n: effs.length });
  }
  const ch = trades.filter(t => t.flags && t.flags.chased), nch = trades.filter(t => t.flags && !t.flags.chased);
  if (ch.length >= 3 && nch.length >= 3) {
    const a = mean(ch.map(t => t.pnl)), b = mean(nch.map(t => t.pnl));
    out.push({ level: a < b ? 'warn' : 'info', text: `追價進場 ${ch.length} 筆,平均每筆 ${fmtSigned0(a)} 元;沒追價的 ${nch.length} 筆平均 ${fmtSigned0(b)} 元。`, n: trades.length });
  }
  const ns = trades.filter(t => t.flags && t.flags.noStop), ws = trades.filter(t => t.flags && !t.flags.noStop);
  if (ns.length >= 3) {
    const worst = Math.min(...ns.map(t => t.mae));
    const withStop = ws.length ? `;有停損的 ${ws.length} 筆平均 ${fmtSigned0(mean(ws.map(t => t.pnl)))} 元` : '';
    out.push({ level: 'warn', text: `${ns.length} 筆沒有停損,平均每筆 ${fmtSigned0(mean(ns.map(t => t.pnl)))} 元,最深曾經倒賠 ${Math.round(-worst)} 點${withStop}。`, n: trades.length });
  }
  const sorted = [...trades].sort((a, b) => a.entry_t - b.entry_t);
  const after2 = [];
  for (let i = 2; i < sorted.length; i++) {
    if (sorted[i - 1].game_id === sorted[i].game_id && sorted[i - 2].game_id === sorted[i].game_id &&
      sorted[i - 1].pnl <= 0 && sorted[i - 2].pnl <= 0) after2.push(sorted[i]);
  }
  if (after2.length >= 5) {
    const wr = after2.filter(t => t.pnl > 0).length / after2.length, all = W.length / trades.length;
    out.push({ level: wr < all - 0.1 ? 'warn' : 'info', text: `同一局連虧 2 筆之後的下一筆,勝率 ${fmtPct(wr)}(全部是 ${fmtPct(all)}),平均 ${fmtSigned0(mean(after2.map(t => t.pnl)))} 元。`, n: after2.length });
  }
  const lg = trades.filter(t => t.dir > 0), sh = trades.filter(t => t.dir < 0);
  if (lg.length >= 10 && sh.length >= 10) {
    const a = mean(lg.map(t => t.pnl)), b = mean(sh.map(t => t.pnl));
    if (Math.sign(a) !== Math.sign(b)) out.push({ level: 'info', text: `做多平均每筆 ${fmtSigned0(a)} 元(${lg.length} 筆),做空 ${fmtSigned0(b)} 元(${sh.length} 筆)。`, n: trades.length });
  }
  const nf = trades.filter(t => t.followed === 0), yf = trades.filter(t => t.followed === 1);
  if (nf.length >= 3 && yf.length >= 3) {
    out.push({ level: 'warn', text: `沒照策略的 ${nf.length} 筆平均 ${fmtSigned0(mean(nf.map(t => t.pnl)))} 元;照策略的 ${yf.length} 筆平均 ${fmtSigned0(mean(yf.map(t => t.pnl)))} 元。`, n: nf.length + yf.length });
  }
  return out;
}
function fmtSigned0(v) {
  if (v == null || !isFinite(v)) return '—';
  const r = Math.round(v);
  return (r > 0 ? '+' : r < 0 ? '−' : '') + fmtInt(Math.abs(r));
}

// ── 成就 ──
export const ACH = {
  first_game: { name: '初登場', desc: '完成第一局正式比賽' },
  first_stop: { name: '認錯也是本事', desc: '第一次用停損出場' },
  stops10: { name: '紀律十連', desc: '連續 10 筆都有停損' },
  stops30: { name: '紀律三十連', desc: '連續 30 筆都有停損' },
  clean_game: { name: '零違規', desc: '一局有交易,沒有被擋下的違規、沒有追價、每筆都有停損' },
  r2: { name: '抱得住', desc: '單筆賺到 2R 以上' },
  t100: { name: '百筆里程碑', desc: '累積 100 筆正式交易' },
  quick10: { name: '快手', desc: '完成 10 場快速局' },
  gap_win: { name: '跳空獵人', desc: '在跳空盤情境關卡獲利' },
  beat90: { name: '贏過猴群', desc: '單局成績贏過 90% 的隨機猴子' },
  green5: { name: '穩定輸出', desc: '連續 5 局正式比賽賺錢' },
  no_chase: { name: '不追價', desc: '一局 5 筆以上交易,都沒有追價' },
};

// prevGames/prevTrades:這一局之前的(計入戰績的);game:這一局 {mode, format, scenario, summary, monkey};trades:這一局的
export function newAchievements(have, prevGames, prevTrades, game, trades) {
  const got = [];
  const add = c => { if (!have.has(c) && !got.includes(c)) got.push(c); };
  if (!COUNTED.has(game.mode)) return got;
  add('first_game');
  if (trades.some(t => t.flags.exitBy === 'sl')) add('first_stop');
  const all = [...prevTrades].sort((a, b) => a.entry_t - b.entry_t).concat(trades);
  let run = 0, best = 0;
  for (const t of all) { if (t.flags && !t.flags.noStop) { run++; best = Math.max(best, run); } else run = 0; }
  if (best >= 10) add('stops10');
  if (best >= 30) add('stops30');
  const s = game.summary;
  if (trades.length && !s.blocked && !s.chased && !s.noStop) add('clean_game');
  if (trades.some(t => t.r != null && t.r >= 2)) add('r2');
  if (prevTrades.length + trades.length >= 100) add('t100');
  if (prevGames.filter(g => g.format === 'quick').length + (game.format === 'quick' ? 1 : 0) >= 10) add('quick10');
  if (game.scenario === '跳空盤' && s.pnl > 0) add('gap_win');
  const b = gameBeat(game.monkey, s.pnl);
  if (trades.length && b != null && b >= 0.9) add('beat90');
  const seq = [...prevGames].sort((a, b) => a.id - b.id).map(g => (g.summary && g.summary.pnl) || 0).concat([s.pnl]);
  let g5 = 0;
  for (const x of seq) { g5 = x > 0 ? g5 + 1 : 0; if (g5 >= 5) add('green5'); }
  if (trades.length >= 5 && !trades.some(t => t.flags.chased)) add('no_chase');
  return got;
}
