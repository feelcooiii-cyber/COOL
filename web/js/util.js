// 小工具:格式化、時間(台北)、亂數、統計小函式、DOM 小幫手
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const NF = new Intl.NumberFormat('en-US');
export function fmtInt(v) { return v == null || !isFinite(v) ? '—' : NF.format(Math.round(v)); }
export function fmtNum(v, d = 1) {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtSigned(v, d = 0) {
  if (v == null || !isFinite(v)) return '—';
  const r = d ? Math.round(v * 10 ** d) / 10 ** d : Math.round(v);
  const s = r > 0 ? '+' : r < 0 ? '−' : '';
  return s + Math.abs(r).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function fmtPct(v, d = 0) { return v == null || !isFinite(v) ? '—' : (v * 100).toFixed(d) + '%'; }
export function upDn(v) { return v > 0 ? 'up' : v < 0 ? 'dn' : ''; }

// 時間:引擎與資料都用 epoch 毫秒;畫面一律台北時間
const TPE = 8 * 3600 * 1000;
export function hms(ms) { return new Date(ms + TPE).toISOString().slice(11, 19); }
export function hm(ms) { return new Date(ms + TPE).toISOString().slice(11, 16); }
export function ymd(ms) { return new Date(ms + TPE).toISOString().slice(0, 10); }
export function md(date) { const [, m, d] = String(date).split('-'); return `${+m}/${+d}`; }
export const KIND = { D: '日盤', N: '夜盤' };
export const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function weekday(date) { return WEEK[new Date(date + 'T12:00:00+08:00').getUTCDay()]; }
export function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return r ? `${m} 分 ${r} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  return `${h} 小時 ${m % 60} 分`;
}
export function ago(sec) {
  const d = Date.now() / 1000 - sec;
  if (d < 60) return '剛剛';
  if (d < 3600) return Math.floor(d / 60) + ' 分鐘前';
  if (d < 86400) return Math.floor(d / 3600) + ' 小時前';
  return Math.floor(d / 86400) + ' 天前';
}

// 可重現的亂數
export function rng(seed) {
  let a = seed >>> 0 || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sum(a) { let s = 0; for (const x of a) s += x; return s; }
export function mean(a) { return a.length ? sum(a) / a.length : null; }
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function median(a) { return quantile([...a].sort((x, y) => x - y), 0.5); }
export function sd(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(sum(a.map(x => (x - m) ** 2)) / (a.length - 1));
}
export function upperBound(arr, x, n = arr.length) { // 第一個 > x 的位置
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

export function html(strings, ...vals) { // 標籤樣板:${} 自動跳脫,raw(...) 不跳脫
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v && v.__raw) out += v.s;
      else if (Array.isArray(v)) out += v.map(x => (x && x.__raw ? x.s : esc(x))).join('');
      else out += esc(v);
    }
  });
  return out;
}
export const raw = s => ({ __raw: true, s: String(s) });

export function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const COLORS = ['#4f8cff', '#ff7a45', '#36cfc9', '#f759ab', '#9254de', '#fadb14', '#73d13d', '#ff4d4f'];
export function initials(name) { return (String(name || '?').trim()[0] || '?').toUpperCase(); }
