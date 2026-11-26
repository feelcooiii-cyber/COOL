// 撮合引擎:決定每一張單的成交價、記帳(部位、損益、成本、保證金)、拆出每一筆交易。純計算,沒有畫面。
// 單位:時間 = epoch 毫秒;價格 = 點;金額 = 新台幣。給同樣的行情與同樣的操作紀錄,結果一定一樣(可以重算)。
//
// 成交規則(docs\01 第 4 節,用群益真實買賣價驗證過):
//  - 期交所逐筆沒有買賣價,用「最後一跳的方向」估:最後一筆往上跳 → 那筆成交在賣價,所以 賣一 ≈ 最後成交價、
//    買一 ≈ 最後成交價 − 典型價差;往下跳反過來。典型價差依商品、日夜盤、是否快到期校準。
//  - 市價單:買在估計的賣一、賣在估計的買一;最佳一檔只有 l1 口,超過的每多一檔差 levelGap 點。
//  - 限價單:預設價格「穿過」才成交(保守);fillRule = 'touch' 碰到就成交。
//  - 停損單(觸價):成交價碰到觸發價後,變成市價單(再經過下單延遲)。
//  - 下單延遲 latency 毫秒之後才到交易所;開盤前(或休市時)送的單參加開盤集合競價,用開盤價成交。
//  - 成本:每口每邊 手續費 + 期交稅(成交價 × 每點價值 × 十萬分之二,四捨五入到元)。
//  - 保證金:開新倉要權益 ≥ 原始保證金 × 口數;權益 < 維持保證金 → 追繳提醒;權益 < 原始保證金的 25% → 強制平倉。
export const ENGINE_VERSION = 1;

const LIVE = new Set(['pending', 'working']);

export class Engine {
  constructor(o) {
    // o: {stream, segs:[{t0,t1,spread}], mult, latency, fillRule, l1, levelGap, commission, taxRate, capital, im, mm}
    this.o = o;
    const s = o.stream;
    this.T = s.T; this.P = s.P; this.Q = s.Q; this.F = s.F; this.S = s.S; this.n = s.n;
    this.segs = o.segs;
    this.i = 0; this.now = -Infinity;
    this.last = null; this.dir = 0; this.lastSeg = -1;
    this.pos = 0; this.avg = 0; this.realized = 0; this.costs = 0;
    this.orders = []; this.active = []; this.nextId = 1;
    this.fills = []; this.events = [];
    this.trades = []; this.cur = null;
    this.peak = o.capital; this.maxDD = 0; this.marginCalled = false; this.liquidating = false;
    this.curve = []; this.lastSample = -Infinity;
  }

  // ── 市場狀態 ──
  segAt(t) {
    for (let k = 0; k < this.segs.length; k++) if (t >= this.segs[k].t0 && t <= this.segs[k].t1) return k;
    return -1;
  }
  isOpen(t) { const k = this.segAt(t); return k >= 0 && k === this.lastSeg && this.last !== null; }
  spread() { const g = this.segs[Math.max(0, this.lastSeg)]; return g ? g.spread : 4; }
  ask() {
    const S = this.spread();
    if (this.dir > 0) return this.last;
    if (this.dir < 0) return this.last + S;
    return this.last + Math.ceil(S / 2);
  }
  bid() {
    const S = this.spread();
    if (this.dir < 0) return this.last;
    if (this.dir > 0) return this.last - S;
    return this.last - Math.floor(S / 2);
  }
  unreal(mark = this.last) { return this.pos && mark != null ? (mark - this.avg) * this.pos * this.o.mult : 0; }
  equity(mark = this.last) { return this.o.capital + this.realized - this.costs + this.unreal(mark); }
  pnl() { return this.equity() - this.o.capital; }

  // 開始前的行情(同一盤、這一局開始之前):只更新最後價格,不撮合
  warmup(t) {
    while (this.i < this.n && this.T[this.i] < t) { this._updateLast(this.i); this.i++; }
    this.now = t;
  }
  _updateLast(i) {
    const p = this.P[i];
    if (this.last !== null && p !== this.last) this.dir = p > this.last ? 1 : -1;
    this.last = p;
    this.lastSeg = this.S[i];
  }

  // ── 下單 ──
  submit(o) {
    // o: {type:'MKT'|'LMT'|'STP', side:+1/-1, qty, price, trig, role:'entry'|'exit'|'sl'|'tp'|'flat', bracket:{sl,tp}, tag, reason}
    const ord = {
      id: this.nextId++, type: o.type, side: o.side, qty: o.qty, price: o.price ?? null, trig: o.trig ?? null,
      role: o.role || 'entry', bracket: o.bracket || null, tag: o.tag ?? null, reason: o.reason || null,
      submitT: this.now, arriveT: this.now + this.o.latency, status: 'pending', filled: 0, avgFill: 0, parent: o.parent ?? null,
    };
    this.orders.push(ord);
    if (!(ord.qty >= 1) || !Number.isInteger(ord.qty)) return this._reject(ord, '口數不對');
    if (ord.type === 'LMT' && !(ord.price > 0)) return this._reject(ord, '限價不對');
    if (ord.type === 'STP' && !(ord.trig > 0)) return this._reject(ord, '觸發價不對');
    if (!o.force && this.opens(ord.side, ord.qty) && !this.marginOk(ord.side, ord.qty)) return this._reject(ord, '保證金不足');
    this.active.push(ord);
    this.events.push({ type: 'order', order: ord });
    return ord;
  }
  _reject(ord, why) {
    ord.status = 'rejected'; ord.reason = why;
    this.events.push({ type: 'reject', order: ord, reason: why });
    return ord;
  }
  opens(side, qty) { return this.pos === 0 || Math.sign(this.pos) === side || qty > Math.abs(this.pos); }
  newAbs(side, qty) {
    if (this.pos === 0 || Math.sign(this.pos) === side) return Math.abs(this.pos) + qty;
    return Math.abs(qty - Math.abs(this.pos));
  }
  marginOk(side, qty) { return this.equity() >= this.newAbs(side, qty) * this.o.im; }

  cancel(id, why = 'cancel') {
    const o = this.active.find(x => x.id === id);
    if (!o) return false;
    o.status = 'cancelled'; o.reason = why;
    this._remove(o);
    this.events.push({ type: 'cancel', order: o });
    return true;
  }
  cancelWhere(pred, why) { for (const o of this.active.slice()) if (pred(o)) this.cancel(o.id, why); }
  cancelAll(why = 'cancel') { this.cancelWhere(() => true, why); }
  modify(id, price) {
    const o = this.active.find(x => x.id === id);
    if (!o) return false;
    if (o.type === 'LMT') o.price = price;
    else if (o.type === 'STP') o.trig = price;
    else return false;
    this.events.push({ type: 'modify', order: o });
    return true;
  }
  flatten(reason = 'flat') {
    this.cancelAll(reason);
    if (this.pos === 0) return null;
    return this.submit({ type: 'MKT', side: -Math.sign(this.pos), qty: Math.abs(this.pos), role: 'flat', reason, force: true });
  }
  _remove(o) { const k = this.active.indexOf(o); if (k >= 0) this.active.splice(k, 1); }

  // ── 時間前進 ──
  advanceTo(t) {
    while (this.i < this.n && this.T[this.i] <= t) {
      const ti = this.T[this.i];
      this._arrivals(ti, true);
      if (ti > this.now) this.now = ti;               // 處理這一筆時產生的單(強制平倉等)用這一筆的時間
      this._print(this.i);
      this.i++;
    }
    this._arrivals(t, false);
    if (t > this.now) this.now = t;
  }

  _arrivals(t, strict) {
    if (!this.active.length) return;
    const list = this.active.filter(o => o.status === 'pending' && (strict ? o.arriveT < t : o.arriveT <= t))
      .sort((a, b) => a.arriveT - b.arriveT || a.id - b.id);
    for (const o of list) {
      if (o.status !== 'pending') continue;
      if (!this.isOpen(o.arriveT)) continue;          // 開盤前/休市:等開盤
      this._activate(o, o.arriveT);
    }
  }

  _activate(o, t) {
    if (o.type === 'MKT') {
      this._fillMarket(o, t, null, 'mkt');
    } else if (o.type === 'LMT') {
      const marketable = o.side > 0 ? o.price >= this.ask() : o.price <= this.bid();
      if (marketable) this._fillMarket(o, t, o.price, 'lmt');
      if (o.status === 'pending') o.status = 'working';
    } else if (o.type === 'STP') {
      const hit = o.side > 0 ? this.last >= o.trig : this.last <= o.trig;
      if (hit) this._trigger(o, t);
      else o.status = 'working';
    }
  }

  _trigger(o, t) {
    o.status = 'triggered';
    this._remove(o);
    this.events.push({ type: 'trigger', order: o });
    const m = {
      id: this.nextId++, type: 'MKT', side: o.side, qty: o.qty - o.filled, price: null, trig: null, role: o.role,
      bracket: o.bracket, tag: o.tag, reason: o.reason, submitT: t, arriveT: t + this.o.latency, status: 'pending',
      filled: 0, avgFill: 0, parent: o.id, fromStop: true,
    };
    this.orders.push(m);
    this.active.push(m);
  }

  _print(i) {
    const p = this.P[i], t = this.T[i], seg = this.S[i], auc = (this.F[i] & 1) === 1;
    const newSeg = seg !== this.lastSeg;
    if (newSeg && auc) {                                  // 開盤集合競價:之前送到的單、掛著的限價單,能成交的都用開盤價成交
      const wait = this.active.filter(o => (o.status === 'pending' && o.arriveT <= t) || (o.status === 'working' && o.type === 'LMT'))
        .sort((a, b) => a.arriveT - b.arriveT || a.id - b.id);
      for (const o of wait) if (o.status === 'pending' || o.status === 'working') this._auction(o, p, t);
    }
    this._updateLast(i);
    if (newSeg && !auc) {                                 // 沒有集合競價標記的第一筆:照一般方式處理等開盤的單
      const wait = this.active.filter(o => o.status === 'pending' && o.arriveT <= t).sort((a, b) => a.arriveT - b.arriveT || a.id - b.id);
      for (const o of wait) if (o.status === 'pending') this._activate(o, t);
    }
    if (this.active.length) {
      for (const o of this.active.slice()) {
        if (o.status !== 'working') continue;
        if (o.type === 'LMT') {
          const hit = this.o.fillRule === 'touch' ? (o.side > 0 ? p <= o.price : p >= o.price) : (o.side > 0 ? p < o.price : p > o.price);
          if (hit) this._fill(o, o.price, o.qty - o.filled, t, 'lmt');
        } else if (o.type === 'STP') {
          if (o.side > 0 ? p >= o.trig : p <= o.trig) this._trigger(o, t);
        }
      }
    }
    this._mtm(t);
  }

  _auction(o, p, t) {
    if (o.type === 'MKT') this._fill(o, p, o.qty - o.filled, t, 'auc');
    else if (o.type === 'LMT') {
      if (o.side > 0 ? o.price >= p : o.price <= p) this._fill(o, p, o.qty - o.filled, t, 'auc');
      else o.status = 'working';
    } else if (o.type === 'STP' && o.status === 'pending') o.status = 'working';
  }

  _fillMarket(o, t, cap, liq) {
    let remaining = o.qty - o.filled;
    const best = o.side > 0 ? this.ask() : this.bid();
    const l1 = Math.max(1, this.o.l1 | 0), gap = this.o.levelGap;
    let level = 0;
    while (remaining > 0) {
      const px = best + o.side * level * gap;
      if (cap != null && (o.side > 0 ? px > cap : px < cap)) break;
      const q = Math.min(remaining, l1);
      this._fill(o, px, q, t, liq);
      remaining -= q;
      level++;
    }
  }

  _fill(o, px, q, t, liq) {
    if (q <= 0) return;
    const f = { id: this.fills.length + 1, oid: o.id, t, px, qty: q, side: o.side, liq, role: o.role, reason: o.reason };
    this.fills.push(f);
    o.avgFill = (o.avgFill * o.filled + px * q) / (o.filled + q);
    o.filled += q;
    if (o.filled >= o.qty) { o.status = 'filled'; this._remove(o); }
    const cpl = this.o.commission + Math.round(px * this.o.mult * this.o.taxRate);
    this.costs += cpl * q;
    let rem = q;
    if (this.pos !== 0 && Math.sign(this.pos) !== o.side) {             // 平倉的部分
      const c = Math.min(rem, Math.abs(this.pos));
      const pnl = (px - this.avg) * c * Math.sign(this.pos) * this.o.mult;
      this.realized += pnl;
      this.pos += o.side * c;
      this._tradeExit(t, px, c, pnl, cpl * c, o);
      rem -= c;
      if (this.pos === 0) { this.avg = 0; this._tradeClose(t); }
    }
    if (rem > 0) {                                                       // 新倉的部分(含反手剩下的)
      const abs = Math.abs(this.pos);
      this.avg = (this.avg * abs + px * rem) / (abs + rem);
      this.pos += o.side * rem;
      this._tradeEntry(t, px, rem, cpl * rem, o);
    }
    f.pos = this.pos;
    this.events.push({ type: 'fill', fill: f, order: o });
    if (this.pos === 0) {
      this.liquidating = false;
      this.cancelWhere(x => x.role === 'sl' || x.role === 'tp', 'flat');
    } else if (rem > 0 && o.bracket && (o.bracket.sl > 0 || o.bracket.tp > 0)) {
      this._attachBracket(o.bracket, t);
    } else {
      this._syncProtective();
    }
  }

  // 停損停利跟著部位:每次加碼重新掛在新均價的上下;部位減少就跟著減口數
  _attachBracket(b, t) {
    this.cancelWhere(x => x.role === 'sl' || x.role === 'tp', 'rebracket');
    const dir = Math.sign(this.pos), abs = Math.abs(this.pos), side = -dir;
    const mk = (type, extra) => {
      const ord = {
        id: this.nextId++, type, side, qty: abs, price: null, trig: null, role: type === 'STP' ? 'sl' : 'tp', bracket: null,
        tag: null, reason: null, submitT: t, arriveT: t + this.o.latency, status: 'pending', filled: 0, avgFill: 0, parent: null, ...extra,
      };
      this.orders.push(ord);
      this.active.push(ord);
      this.events.push({ type: 'order', order: ord });
    };
    if (b.sl > 0) mk('STP', { trig: Math.round(this.avg - dir * b.sl) });
    if (b.tp > 0) mk('LMT', { price: Math.round(this.avg + dir * b.tp) });
  }
  _syncProtective() {
    const abs = Math.abs(this.pos), dir = Math.sign(this.pos);
    for (const x of this.active.slice()) {
      if (x.role !== 'sl' && x.role !== 'tp') continue;
      if (x.side === dir) this.cancel(x.id, 'flip');
      else if (x.qty - x.filled > abs) x.qty = x.filled + abs;
    }
  }

  // ── 交易(一進一出)──
  _tradeEntry(t, px, q, cost, o) {
    if (!this.cur) {
      this.cur = {
        seq: this.trades.length + 1, dir: Math.sign(this.pos), entryT: t, exitT: null, inQty: 0, inVal: 0, outQty: 0, outVal: 0,
        gross: 0, costs: 0, maxQty: 0, mfe: 0, mae: 0, risk: null, hasStop: false, tag: o.tag, exitBy: null, forced: null,
        entryOid: o.id, firstPx: px,
      };
    }
    const c = this.cur;
    c.inQty += q; c.inVal += px * q; c.costs += cost;
    c.maxQty = Math.max(c.maxQty, Math.abs(this.pos));
    if (c.tag == null && o.tag != null) c.tag = o.tag;
  }
  _tradeExit(t, px, q, pnl, cost, o) {
    const c = this.cur;
    if (!c) return;
    c.outQty += q; c.outVal += px * q; c.gross += pnl; c.costs += cost; c.exitT = t;
    if (o.role === 'sl' || o.role === 'tp') c.exitBy = o.role;
    else if (o.role === 'flat' && o.reason && o.reason !== 'flat') { c.exitBy = o.reason; c.forced = o.reason; }
    else c.exitBy = 'manual';
  }
  _tradeClose(t) {
    const c = this.cur;
    if (!c) return;
    c.exitT = t;
    c.entryPx = c.inVal / c.inQty;
    c.exitPx = c.outVal / c.outQty;
    c.pnl = c.gross - c.costs;
    c.points = c.gross / this.o.mult / c.outQty;
    this.trades.push(c);
    this.cur = null;
    this.events.push({ type: 'trade', trade: c });
  }

  // ── 每一筆成交之後:最大有利／不利、權益、回撤、保證金 ──
  _mtm(t) {
    if (this.pos !== 0) {
      const c = this.cur;
      if (c) {
        const u = (this.last - this.avg) * Math.sign(this.pos);
        if (u > c.mfe) c.mfe = u;
        if (u < c.mae) c.mae = u;
        if (!c.hasStop) {
          const st = this.active.find(x => x.type === 'STP' && x.side === -Math.sign(this.pos));
          if (st) { c.hasStop = true; c.risk = Math.abs(this.avg - st.trig); }
        }
      }
      const eq = this.equity();
      if (eq > this.peak) this.peak = eq;
      if (this.peak - eq > this.maxDD) this.maxDD = this.peak - eq;
      const need = Math.abs(this.pos);
      if (!this.liquidating && eq < 0.25 * this.o.im * need) {
        this.liquidating = true;
        this.events.push({ type: 'liquidate' });
        this.flatten('risk');
      } else if (eq < this.o.mm * need) {
        if (!this.marginCalled) { this.marginCalled = true; this.events.push({ type: 'margin_call' }); }
      } else this.marginCalled = false;
    } else {
      const eq = this.equity();
      if (eq > this.peak) this.peak = eq;
      if (this.peak - eq > this.maxDD) this.maxDD = this.peak - eq;
    }
    if (t - this.lastSample >= 60000) { this.lastSample = t; this.curve.push([t, Math.round(this.equity())]); }
    if (this.onMark) this.onMark(t);                    // 外層的逐筆檢查(單局虧損上限)
  }

  // 結束:取消所有單,剩下的部位用當下的估計買賣價平倉(不再等延遲)
  closeAt(t, reason = 'end') {
    this.advanceTo(t);
    this.cancelAll(reason);
    if (this.pos !== 0 && this.last !== null) {
      const o = {
        id: this.nextId++, type: 'MKT', side: -Math.sign(this.pos), qty: Math.abs(this.pos), role: 'flat', reason,
        bracket: null, tag: null, submitT: t, arriveT: t, status: 'pending', filled: 0, avgFill: 0, parent: null,
      };
      this.orders.push(o);
      this.active.push(o);
      this._fillMarket(o, t, null, 'mkt');
    }
    this.curve.push([t, Math.round(this.equity())]);
  }

  snapshot() {
    return {
      pos: this.pos, avg: this.avg, last: this.last, bid: this.last == null ? null : this.bid(), ask: this.last == null ? null : this.ask(),
      realized: this.realized, costs: this.costs, unreal: this.unreal(), equity: this.equity(), pnl: this.pnl(), maxDD: this.maxDD,
    };
  }
}
