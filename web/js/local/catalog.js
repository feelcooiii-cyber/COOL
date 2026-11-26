// 行情目錄:網站上的 data/catalog.json(雲端每天更新)。先用上次存的,背景再向網站要新的。
const URL_ = 'data/catalog.json';
const LS_KEY = 'arena.catalog.v1';

let cat = null;
let listeners = [];
export const updateInfo = { checking: false, last_check: null, error: null, added: 0 };

function index(c) {
  const byKey = new Map();
  const tags = new Map();
  for (const r of c.sessions) byKey.set(r.sid + '|' + r.product + '|' + r.month, r);
  for (const t of c.tags || []) tags.set(t.sid, t);
  c.sessions.sort((a, b) => a.t0 - b.t0 || (a.month < b.month ? -1 : 1));
  return { ...c, byKey, tagMap: tags };
}

function saveLocal(c) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ updated: c.updated, sessions: c.sessions, tags: c.tags, spread: c.spread })); } catch (e) { /* 容量不夠就算了 */ }
}
function loadLocal() {
  try { const s = localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

async function fetchRemote() {
  const r = await fetch(URL_ + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('讀不到行情目錄(HTTP ' + r.status + ')');
  return r.json();
}

export async function init() {
  const local = loadLocal();
  if (local) { cat = index(local); refresh(); return; }
  const c = await fetchRemote();
  cat = index(c);
  saveLocal(c);
  updateInfo.last_check = Date.now() / 1000;
}

// 向網站檢查有沒有新的行情(打開時、每 30 分鐘、按「檢查更新」)
export async function refresh() {
  if (updateInfo.checking) return false;
  updateInfo.checking = true;
  try {
    const c = await fetchRemote();
    const before = cat ? cat.sessions.length : 0;
    const changed = !cat || c.updated !== cat.updated;
    if (changed) {
      cat = index(c);
      saveLocal(c);
      updateInfo.added = Math.max(0, cat.sessions.length - before);
    }
    updateInfo.error = null;
    updateInfo.last_check = Date.now() / 1000;
    if (changed) listeners.forEach(f => f());
    return changed;
  } catch (e) {
    updateInfo.error = navigator.onLine === false ? '沒有網路,先用手機裡的行情' : e.message;
    updateInfo.last_check = Date.now() / 1000;
    return false;
  } finally {
    updateInfo.checking = false;
  }
}
export function onChange(f) { listeners.push(f); }

export const catalog = () => cat;
export const sessions = () => cat.sessions;
export const sessionRow = (sid, product, month) => cat.byKey.get(sid + '|' + product + '|' + month) || null;
export const tag = sid => cat.tagMap.get(sid) || null;
export const spreadRows = () => cat.spread || [];
