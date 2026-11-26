// 手機版設定:跟電腦版 arena/config.py 一樣的商品規格與預設值
export const VERSION = '1.0.0-m1';
export const ENGINE_VERSION = 1;

export const PRODUCTS = {
  TX: { name: '大台', mult: 200, tick: 1, im: 701000, mm: 538000, big: 10, l1: 2, quote: 'TX00' },
  MTX: { name: '小台', mult: 50, tick: 1, im: 175250, mm: 134500, big: 20, l1: 2, quote: 'MTX00' },
  TMF: { name: '微台', mult: 10, tick: 1, im: 35050, mm: 26900, big: 50, l1: 2, quote: null },
};
export const PRODUCT_ORDER = ['MTX', 'TX', 'TMF'];
export const TAX_RATE = 0.00002;

export const DEFAULT_SPREAD = {
  'TX|D|0': 5, 'TX|N|0': 6, 'TX|D|1': 10, 'TX|N|1': 8,
  'MTX|D|0': 4, 'MTX|N|0': 3, 'MTX|D|1': 7, 'MTX|N|1': 4,
};
export const SPREAD_FALLBACK = { TMF: 'MTX' };

export const HOUR_WINDOW = 3600;
export const QUICK_SECONDS = 300;

export const DEFAULT_SETTINGS = {
  latency_ms: 200,
  fill_rule: 'through',
  level_gap: 1,
  chase_pts: 30,
  chase_sec: 30,
  sound: true,
  hide_price: false,
  unseen_rule: true,
  smart_fast: true,
  fast_speed: 30,
  move_pts: 15,
  move_sec: 20,
  margins: Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [k, { im: v.im, mm: v.mm }])),
  big_lots: Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [k, v.big])),
  l1: Object.fromEntries(Object.entries(PRODUCTS).map(([k, v]) => [k, v.l1])),
};
