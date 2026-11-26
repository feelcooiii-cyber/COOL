// 手機版的資料庫:參賽者、每一局、每一筆交易、看過的行情、成就、設定，都存在這台手機的 IndexedDB。
// 啟動時整份讀進記憶體（資料量小），之後每次改動寫回 IndexedDB。IndexedDB 不能用時（私密瀏覽等）退回只存在記憶體。
const DB_NAME = 'taizhi-arena';
const DB_VER = 1;
export const TABLES = ['contestant', 'game', 'trade', 'seen', 'achievement', 'setting', 'meta'];
const KEY = { achievement: r => r.contestant_id + ':' + r.code, setting: r => r.key, meta: r => r.key };

let idb = null;
const mem = {};          // table → Map(key → row)
const seq = {};          // table → 下一個 id
let persistent = false;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readAll(t) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    const tx = idb.transaction(t, 'readonly');
    const cur = tx.objectStore(t).openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { out.set(c.key, c.value); c.continue(); } else resolve(out); };
    cur.onerror = () => reject(cur.error);
  });
}

export async function init() {
  try {
    idb = await open();
    for (const t of TABLES) mem[t] = await readAll(t);
    persistent = true;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    console.warn('IndexedDB 不能用,資料只存在這次開啟', e);
    idb = null;
    for (const t of TABLES) mem[t] = new Map();
  }
  for (const t of TABLES) {
    let m = 0;
    for (const r of mem[t].values()) if (typeof r.id === 'number' && r.id > m) m = r.id;
    seq[t] = m + 1;
  }
}
export const isPersistent = () => persistent;

function keyOf(t, r) { return KEY[t] ? KEY[t](r) : r.id; }

function write(ops) {           // ops = [[table, 'put'|'del', key, value]]
  if (!idb) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction([...new Set(ops.map(o => o[0]))], 'readwrite');
    for (const [t, op, k, v] of ops) {
      const s = tx.objectStore(t);
      if (op === 'put') s.put(v, k); else s.delete(k);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const clone = v => (v == null ? v : structuredClone(v));

export function all(t) { return [...mem[t].values()].map(clone); }
export function get(t, k) { return clone(mem[t].get(k)); }

// 一次改多筆:fn(tx) 裡用 tx.insert / tx.put / tx.del,最後一起寫回
export async function batch(fn) {
  const ops = [];
  const tx = {
    insert(t, row) {
      const r = { ...row, id: seq[t]++ };
      mem[t].set(r.id, r); ops.push([t, 'put', r.id, clone(r)]);
      return r.id;
    },
    put(t, row) {
      const k = keyOf(t, row);
      mem[t].set(k, row); ops.push([t, 'put', k, clone(row)]);
    },
    del(t, k) { mem[t].delete(k); ops.push([t, 'del', k]); },
  };
  const out = fn(tx);
  if (ops.length) await write(ops);
  return out;
}

export function insert(t, row) { return batch(tx => tx.insert(t, row)); }
export function put(t, row) { return batch(tx => tx.put(t, row)); }

// 備份/還原(整份 JSON)
export function dump() {
  const out = { app: 'taizhi-arena', format: 1, at: Date.now() / 1000, tables: {} };
  for (const t of TABLES) if (t !== 'meta') out.tables[t] = all(t);
  return out;
}
export async function restore(data) {
  if (!data || data.app !== 'taizhi-arena' || !data.tables) throw new Error('不是台指競技場的備份檔');
  const ops = [];
  for (const t of TABLES) {
    if (t === 'meta') continue;
    for (const k of mem[t].keys()) ops.push([t, 'del', k]);
    mem[t] = new Map();
    for (const r of data.tables[t] || []) { const k = keyOf(t, r); mem[t].set(k, r); ops.push([t, 'put', k, r]); }
    let m = 0;
    for (const r of mem[t].values()) if (typeof r.id === 'number' && r.id > m) m = r.id;
    seq[t] = m + 1;
  }
  await write(ops);
}
