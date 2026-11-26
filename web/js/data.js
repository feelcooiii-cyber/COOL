// 行情資料:讀 .bin 逐筆檔、組成一局的逐筆流、組 K 棒
const cache = new Map();          // 檔名 → Promise<bin>
const ORDER = [];

export function parseBin(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic === 'ARN2') return parseBin2(buf);
  if (magic !== 'ARN1') throw new Error('行情檔格式不對');
  const n = dv.getUint32(4, true), t0 = dv.getFloat64(8, true);
  return {
    n, t0,
    t: new Int32Array(buf, 16, n), px: new Int32Array(buf, 16 + 4 * n, n),
    q: new Int32Array(buf, 16 + 8 * n, n), f: new Uint8Array(buf, 16 + 12 * n, n),
  };
}

// 手機版行情檔(.arz):gzip 壓縮的 ARN2 = 時間、價格改存「和前一筆的差」,比原本小 10 倍以上
function parseBin2(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(4, true), t0 = dv.getFloat64(8, true);
  const t = new Int32Array(buf.slice(16, 16 + 4 * n)), px = new Int32Array(buf.slice(16 + 4 * n, 16 + 8 * n));
  for (let i = 1; i < n; i++) { t[i] += t[i - 1]; px[i] += px[i - 1]; }
  return { n, t0, t, px, q: new Int32Array(buf, 16 + 8 * n, n), f: new Uint8Array(buf, 16 + 12 * n, n) };
}

async function gunzip(r) {
  if (typeof DecompressionStream === 'undefined') throw new Error('這個瀏覽器太舊,不能解壓行情檔(請更新 iOS 16.4／Chrome 80 以上)');
  return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export function loadBin(file) {
  if (!cache.has(file)) {
    const name = file.replace(/\.bin$/, '.arz');
    const p = fetch('data/sessions/' + name)
      .then(r => { if (!r.ok) throw new Error(navigator.onLine === false ? '沒有網路,這一盤還沒下載過' : '讀不到行情檔 ' + name); return gunzip(r); })
      .then(parseBin);
    p.catch(() => cache.delete(file));
    cache.set(file, p);
    ORDER.push(file);
    while (ORDER.length > 12) cache.delete(ORDER.shift());
  }
  return cache.get(file);
}

// 一局用到的盤 → 一條逐筆流(時間 = epoch 毫秒;S = 第幾段)
export function buildStream(bins) {
  let n = 0;
  for (const b of bins) n += b.n;
  const T = new Float64Array(n), P = new Int32Array(n), Q = new Int32Array(n), F = new Uint8Array(n), S = new Uint8Array(n);
  let k = 0;
  bins.forEach((b, si) => {
    const base = b.t0 * 1000;
    for (let i = 0; i < b.n; i++) {
      T[k] = base + b.t[i]; P[k] = b.px[i]; Q[k] = b.q[i]; F[k] = b.f[i]; S[k] = si; k++;
    }
  });
  return { n: k, T, P, Q, F, S };
}

// K 棒時間:lightweight-charts 用 UTC 秒;加 8 小時讓圖上顯示台北時間
export const TZ = 8 * 3600;
export function barTime(ms, tf) {
  const s = Math.floor(ms / 1000) + TZ;
  return s - (s % (tf * 60));
}

// 一段逐筆 → K 棒陣列(off = 顯示用的價格平移)
export function makeBars(T, P, Q, i0, i1, tf, off = 0) {
  const out = [];
  let cur = null;
  for (let i = i0; i < i1; i++) {
    const t = barTime(T[i], tf), p = P[i] + off;
    if (!cur || cur.time !== t) {
      cur = { time: t, open: p, high: p, low: p, close: p, volume: Q[i] };
      out.push(cur);
    } else {
      if (p > cur.high) cur.high = p;
      if (p < cur.low) cur.low = p;
      cur.close = p;
      cur.volume += Q[i];
    }
  }
  return out;
}

// 逐筆一筆一筆加進來的 K 棒(比賽中用)
export class BarBuilder {
  constructor(tf, off = 0) { this.tf = tf; this.off = off; this.cur = null; }
  push(t, p, q) {
    const bt = barTime(t, this.tf), px = p + this.off;
    if (!this.cur || this.cur.time !== bt) {
      this.cur = { time: bt, open: px, high: px, low: px, close: px, volume: q };
      return true;
    }
    const c = this.cur;
    if (px > c.high) c.high = px;
    if (px < c.low) c.low = px;
    c.close = px;
    c.volume += q;
    return false;
  }
}
