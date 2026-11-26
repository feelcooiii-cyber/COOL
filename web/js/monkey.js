// 隨機猴子:
//  1) matchedMonkey:結算時的對照組。同一段行情、同樣筆數、同樣持有時間與口數、同樣的多空比例(方向打散),
//     只把進場時間換成隨機,算 trials 次的總損益(扣成本)→ 你的成績贏過幾成的猴子。
//  2) playMonkey:「電腦隨機猴子」參賽者自己下場比賽(隨機時間、隨機方向、持有時間隨機),和真人用同一個撮合引擎。
import { rng, upperBound } from './util.js';

export function matchedMonkey(game, trades, trials = 200, seed = 1) {
  if (!trades.length) return [];
  const { T, P, S, n } = game.stream;
  const D = new Int8Array(n);                    // 每一筆之後的「最後一跳方向」
  let d = 0;
  for (let i = 1; i < n; i++) { if (P[i] !== P[i - 1]) d = P[i] > P[i - 1] ? 1 : -1; D[i] = d; }
  const spread = game.segs.map(g => g.spread);
  const quote = (x, side) => {                   // side > 0 買(用賣一)、< 0 賣(用買一)
    let j = upperBound(T, x, n) - 1;
    if (j < 0) j = 0;
    const last = P[j], dd = D[j], s = spread[S[j]] ?? 4;
    if (side > 0) return dd > 0 ? last : dd < 0 ? last + s : last + Math.ceil(s / 2);
    return dd < 0 ? last : dd > 0 ? last - s : last - Math.floor(s / 2);
  };
  const L = game.tradingLen, mult = game.mult, com = game.c.commission || 0, tax = game.spec.tax_rate;
  const taxOf = px => Math.round(px * mult * tax);
  const dirs = trades.map(t => t.dir);
  const r = rng(seed);
  const out = [];
  for (let k = 0; k < trials; k++) {
    for (let i = dirs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [dirs[i], dirs[j]] = [dirs[j], dirs[i]]; }
    let tot = 0;
    trades.forEach((t, i) => {
      const h = Math.min(L, Math.max(1000, t.hold * 1000));
      const u0 = r() * Math.max(0, L - h);
      const x0 = game.clockAt(u0), x1 = game.clockAt(u0 + h);
      const dir = dirs[i], q = t.qty;
      const pin = quote(x0, dir), pout = quote(x1, -dir);
      tot += (pout - pin) * dir * q * mult - q * (2 * com + taxOf(pin) + taxOf(pout));
    });
    out.push(Math.round(tot));
  }
  return out;
}

// 電腦隨機猴子下場:params = {trades 每局幾筆, holdMin 平均持有分鐘, qty 口數, sl 停損點數, tp 停利點數}
export function playMonkey(game, params, seed) {
  const r = rng(seed);
  const k = Math.max(1, params.trades | 0 || 5);
  const holdMs = Math.max(1, Number(params.holdMin) || 15) * 60000;
  const qty = Math.max(1, params.qty | 0 || 1);
  const bracket = (params.sl > 0 || params.tp > 0) ? { sl: Number(params.sl) || 0, tp: Number(params.tp) || 0 } : null;
  const L = game.tradingLen;
  const pts = Array.from({ length: k }, () => r() * L).sort((a, b) => a - b);
  let busyUntil = -1;
  for (const u of pts) {
    if (u < busyUntil) continue;
    const hold = Math.min(L - u, -Math.log(1 - r()) * holdMs);
    if (hold < 60000) continue;
    const side = r() < 0.5 ? 1 : -1;
    const t0 = game.clockAt(u), t1 = game.clockAt(u + hold);
    game.advance(t0);
    game.act('mkt', { side, qty, bracket });
    game.advance(t1);
    if (game.engine.pos !== 0) game.act('flat');
    busyUntil = u + hold;
  }
  game.advance(game.end);
  return game.finish('end');
}
