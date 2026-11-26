// 一局比賽:把撮合引擎、參賽者規則、操作紀錄(可以重算)、交易分析(追價、有沒有停損、持有時間)包在一起。
// 畫面只透過 act()/advance()/finish() 操作;同樣的 spec + 同樣的操作紀錄,重算結果一定一樣。
import { Engine } from './engine.js';
import { buildStream, loadBin } from './data.js';
import { upperBound } from './util.js';

export async function loadGameData(spec) {
  const segs = await Promise.all(spec.segments.map(s => loadBin(s.file)));
  const ctx = await Promise.all((spec.context || []).map(s => loadBin(s.file).catch(() => null)));
  return { segs, ctx };
}

export class Game {
  // spec:伺服器發的局;contestant:參賽者;bins:loadGameData 的結果;opt.fillRule 可以覆蓋(結算時算「碰到就成交」用)
  constructor(spec, contestant, bins, opt = {}) {
    this.spec = spec;
    this.c = contestant;
    this.rules = contestant.kind === 'human' ? (contestant.rules || {}) : {};
    this.bins = bins;
    this.stream = buildStream(bins.segs);
    this.start = spec.start * 1000;
    this.end = spec.end * 1000;
    this.segs = spec.segments.map(s => ({ t0: s.t0 * 1000, t1: s.t1 * 1000, spread: s.spread, kind: s.kind }));
    const st = spec.settings || {};
    this.mult = spec.mult;
    this.engine = new Engine({
      stream: this.stream, segs: this.segs, mult: spec.mult, latency: st.latency_ms ?? 200,
      fillRule: opt.fillRule || st.fill_rule || 'through', l1: spec.l1 || 2, levelGap: st.level_gap ?? 1,
      commission: contestant.commission || 0, taxRate: spec.tax_rate, capital: contestant.capital || 1000000,
      im: spec.margin.im, mm: spec.margin.mm,
    });
    this.engine.warmup(this.start);
    this.engine.onMark = t => this._mark(t);    // 逐筆檢查:重算時一定在同一筆觸發
    this.firstIdx = this.engine.i;              // 這一局第一筆(之前的是同一盤稍早的行情)
    this.log = [];
    this.blocked = [];
    this.lossLocked = false;
    this.cooldownUntil = 0;
    this.lossStreak = 0;
    this.seenTrades = 0;
    this.notes = [];                             // 給畫面顯示的提示
    this.finished = false;
    this.chasePts = st.chase_pts ?? 30;
    this.chaseMs = (st.chase_sec ?? 30) * 1000;
    // 交易時間(扣掉日盤收盤到夜盤開盤的休市)
    this.ranges = (spec.ranges || [[spec.start, spec.end]]).map(([a, b]) => [Math.max(a * 1000, this.start), Math.min(b * 1000, this.end)]);
    this.tradingLen = this.ranges.reduce((s, [a, b]) => s + (b - a), 0);
  }

  get now() { return this.engine.now; }
  tradingElapsed(t) {
    let s = 0;
    for (const [a, b] of this.ranges) { if (t <= a) break; s += Math.min(t, b) - a; }
    return s;
  }
  clockAt(u) {                                    // 交易時間 → 時鐘時間
    let left = u;
    for (const [a, b] of this.ranges) { if (left <= b - a) return a + left; left -= b - a; }
    return this.end;
  }
  inBreak(t) { return !this.ranges.some(([a, b]) => t >= a && t <= b); }
  nextOpen(t) { for (const [a] of this.ranges) if (a > t) return a; return this.end; }

  // 某個時間點的成交價(追價判斷、圖用)
  priceAt(t) {
    const j = upperBound(this.stream.T, t, this.stream.n) - 1;
    return j >= 0 ? this.stream.P[j] : null;
  }

  // ── 規則 ──
  openTrades() { return this.engine.trades.length + (this.engine.cur ? 1 : 0); }
  checkEntry(qty, bracket) {
    const r = this.rules;
    if (r.maxLots && qty > r.maxLots) return `規則:每筆最多 ${r.maxLots} 口`;
    if (this.lossLocked) return '規則:這一局已經虧到上限,只能平倉';
    if (r.maxTrades && this.openTrades() >= r.maxTrades && this.engine.pos === 0) return `規則:每局最多 ${r.maxTrades} 筆`;
    if (this.cooldownUntil > this.now) return `規則:連虧冷靜中,還要 ${Math.ceil((this.cooldownUntil - this.now) / 60000)} 分鐘`;
    if (r.requireStop && !(bracket && bracket.sl > 0)) return '規則:進場一定要帶停損';
    return null;
  }

  // ── 操作(畫面呼叫;重算時 replay=true 不再記一次)──
  act(a, p = {}, replay = false) {
    if (this.finished) return { ok: false, msg: '這一局已經結束' };
    const e = this.engine;
    const entry = (side, qty) => e.opens(side, qty);
    let res = { ok: true };
    const block = msg => {
      this.blocked.push({ t: this.now, a, msg });
      res = { ok: false, msg, blocked: true };
    };
    switch (a) {
      case 'mkt': case 'lmt': case 'stp': {
        const side = p.side, qty = p.qty;
        const isEntry = entry(side, qty);
        const bracket = isEntry ? p.bracket : null;
        if (isEntry) { const why = this.checkEntry(qty, bracket); if (why) { block(why); break; } }
        const type = a === 'mkt' ? 'MKT' : a === 'lmt' ? 'LMT' : 'STP';
        const o = e.submit({ type, side, qty, price: p.price, trig: p.trig, role: isEntry ? 'entry' : 'exit', bracket, tag: p.tag ?? null });
        if (o.status === 'rejected') res = { ok: false, msg: o.reason };
        else res = { ok: true, order: o };
        break;
      }
      case 'flat':
        e.flatten('flat');
        break;
      case 'rev': {
        if (e.pos === 0) { res = { ok: false, msg: '沒有部位可以反手' }; break; }
        const qty = Math.abs(e.pos);
        const why = this.checkEntry(qty, p.bracket);
        if (why) { block(why); break; }
        e.cancelAll('rev');
        const o = e.submit({ type: 'MKT', side: -Math.sign(e.pos), qty: qty * 2, role: 'entry', bracket: p.bracket, tag: p.tag ?? null });
        if (o.status === 'rejected') res = { ok: false, msg: o.reason };
        break;
      }
      case 'cxl':
        if (!e.cancel(p.id)) res = { ok: false, msg: '這張單已經不能取消' };
        break;
      case 'cxa':
        e.cancelAll('cancel');
        break;
      case 'mod':
        if (!e.modify(p.id, p.price)) res = { ok: false, msg: '這張單已經不能改' };
        break;
      default:
        return { ok: false, msg: '不認得的操作' };
    }
    if (!replay) this.log.push({ t: this.now, a, ...p });
    return res;
  }

  // 逐筆檢查(引擎每處理一筆成交呼叫一次):單局虧損上限、連虧冷靜
  _mark(t) {
    const e = this.engine;
    if (this.rules.maxLoss > 0 && !this.lossLocked && e.pnl() <= -this.rules.maxLoss) {
      this.lossLocked = true;
      e.flatten('loss');
      this.notes.push({ t, kind: 'loss', msg: `虧到單局上限 ${Number(this.rules.maxLoss).toLocaleString()} 元,自動平倉並鎖住新單` });
    }
    while (this.seenTrades < e.trades.length) {
      const tr = e.trades[this.seenTrades++];
      if (tr.pnl < 0) this.lossStreak++; else this.lossStreak = 0;
      const cd = this.rules.cooldown;
      if (cd && cd.losses > 0 && this.lossStreak >= cd.losses) {
        this.cooldownUntil = tr.exitT + (cd.minutes || 5) * 60000;
        this.lossStreak = 0;
        this.notes.push({ t: tr.exitT, kind: 'cooldown', msg: `連虧 ${cd.losses} 筆,冷靜 ${cd.minutes || 5} 分鐘(市場時間)` });
      }
    }
  }

  // 追價:進場前 chase_sec 秒內,價格已經往進場方向走了 chase_pts 點以上
  chaseOf(tr) {
    const k = this.segs.findIndex(g => tr.entryT >= g.t0 && tr.entryT <= g.t1);
    const from = tr.entryT - this.chaseMs;
    if (k < 0 || from < this.segs[k].t0) return { chased: false, move: null };
    const p0 = this.priceAt(from);
    if (p0 == null) return { chased: false, move: null };
    const move = (tr.firstPx - p0) * tr.dir;
    return { chased: move >= this.chasePts, move };
  }

  // 時間前進到 t,回傳這段時間的事件(畫面用:成交音、提示)
  advance(t) {
    if (this.finished) return [];
    const e = this.engine;
    e.advanceTo(Math.min(t, this.end));
    const evs = e.events;
    e.events = [];
    for (const ev of evs) {
      if (ev.type === 'liquidate') this.notes.push({ t: e.now, kind: 'risk', msg: '保證金不足(權益低於原始保證金 25%),強制平倉' });
      if (ev.type === 'margin_call') this.notes.push({ t: e.now, kind: 'margin', msg: '權益低於維持保證金(追繳)' });
    }
    return evs;
  }

  // 依紀錄重算(繼續上次中斷的局、結算時算另一種成交規則)
  replay(log, upto) {
    for (const x of log) {
      if (x.t > upto) break;
      this.advance(x.t);
      const { t, a, ...p } = x;
      this.act(a, p, true);
      this.log.push(x);
    }
    this.advance(upto);
  }

  finish(reason = 'end') {
    if (this.finished) return this.result;
    const e = this.engine;
    const t = Math.max(Math.min(this.now, this.end), this.start);
    e.closeAt(t, reason);
    this.advance(t);
    this.finished = true;
    this.result = this.compute(reason);
    return this.result;
  }

  // ── 結算 ──
  compute(reason) {
    const e = this.engine, spec = this.spec, mult = this.mult;
    const trades = e.trades.map(tr => {
      const m = this.chaseOf(tr);
      const qty = tr.maxQty;
      const net = tr.pnl / mult / Math.max(1, tr.outQty);
      const k = this.segs.findIndex(g => tr.entryT >= g.t0 && tr.entryT <= g.t1);
      return {
        seq: tr.seq, dir: tr.dir, qty, entry_t: tr.entryT / 1000, exit_t: tr.exitT / 1000,
        entry_px: round2(tr.entryPx), exit_px: round2(tr.exitPx), points: round2(tr.points),
        gross: Math.round(tr.gross), costs: Math.round(tr.costs), pnl: Math.round(tr.pnl),
        mfe: round2(tr.mfe), mae: round2(tr.mae), risk: tr.risk == null ? null : round2(tr.risk),
        r: tr.risk ? round2(net / tr.risk) : null, eff: tr.mfe > 0 ? round2(tr.points / tr.mfe) : null,
        hold: Math.round((this.tradingElapsed(tr.exitT) - this.tradingElapsed(tr.entryT)) / 1000),
        kind: k >= 0 ? this.segs[k].kind : spec.segments[0].kind,
        hour: new Date(tr.entryT + 8 * 3600e3).getUTCHours(),
        flags: { chased: !!m.chased, move: m.move == null ? null : Math.round(m.move), noStop: !tr.hasStop, exitBy: tr.exitBy, forced: tr.forced },
        tag: tr.tag ?? null, followed: null, note: '',
      };
    });
    const pnl = Math.round(e.equity() - e.o.capital);
    const wins = trades.filter(x => x.pnl > 0).length;
    const score = processScore(trades, this.blocked, this.notes, this.rules);
    return {
      trades,
      summary: {
        pnl, gross: Math.round(e.realized), costs: Math.round(e.costs), n: trades.length, wins,
        winRate: trades.length ? wins / trades.length : null, maxDD: Math.round(e.maxDD), endEquity: Math.round(e.equity()),
        blocked: this.blocked.length, chased: trades.filter(x => x.flags.chased).length,
        noStop: trades.filter(x => x.flags.noStop).length, notes: this.notes.map(x => x.msg),
        score: score.score, grade: score.grade, items: score.items, reason,
        product: spec.product, month: spec.month, format: spec.format, mode: spec.mode, scenario: spec.scenario,
        label: spec.label, date: spec.date, start: spec.start, end: spec.end, sids: spec.segments.map(s => s.sid),
        fills: e.fills.length, playedTo: Math.min(this.now, this.end) / 1000,
      },
      equity: e.curve,
    };
  }
}

function round2(v) { return v == null || !isFinite(v) ? null : Math.round(v * 100) / 100; }

// 單局評分只看過程(守規則、停損、追價、出場效率),不看賺賠:單局賺錢可能只是運氣
export function processScore(trades, blocked, notes, rules) {
  const items = [];
  let s = 100;
  if (!trades.length) return { score: null, grade: '觀望', items: [{ k: '這一局沒有交易', v: 0 }] };
  if (blocked.length) { const d = Math.min(40, blocked.length * 8); s -= d; items.push({ k: `想違反規則 ${blocked.length} 次(被擋下)`, v: -d }); }
  const noStop = trades.filter(x => x.flags.noStop).length;
  if (noStop && !rules.requireStop) { const d = Math.min(30, noStop * 10); s -= d; items.push({ k: `${noStop} 筆沒有停損`, v: -d }); }
  const chased = trades.filter(x => x.flags.chased).length;
  if (chased) { const d = Math.min(30, chased * 6); s -= d; items.push({ k: `${chased} 筆追價進場`, v: -d }); }
  const forced = trades.filter(x => x.flags.forced === 'loss' || x.flags.forced === 'risk').length;
  if (forced) { s -= 15; items.push({ k: '被強制平倉(虧損上限或保證金)', v: -15 }); }
  const effs = trades.filter(x => x.pnl > 0 && x.eff != null).map(x => x.eff);
  if (effs.length >= 2) {
    const avg = effs.reduce((a, b) => a + b, 0) / effs.length;
    if (avg < 0.3) { s -= 10; items.push({ k: `獲利單只拿到最大有利的 ${Math.round(avg * 100)}%`, v: -10 }); }
    else if (avg >= 0.6) items.push({ k: `獲利單拿到最大有利的 ${Math.round(avg * 100)}%`, v: 0 });
  }
  if (!items.length) items.push({ k: '守規則、有停損、沒追價', v: 0 });
  s = Math.max(0, s);
  const grade = s >= 90 ? 'S' : s >= 80 ? 'A' : s >= 65 ? 'B' : s >= 50 ? 'C' : 'D';
  return { score: s, grade, items };
}
