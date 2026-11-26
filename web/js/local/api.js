// 手機版「伺服器」:把電腦版 arena/server.py + games.py 的 API 搬到瀏覽器裡,資料存手機(IndexedDB)。
// 畫面照舊呼叫 api.get('/api/...') / api.post(...),這裡用同樣的網址分派。
import * as S from './store.js';
import * as C from './catalog.js';
import { DEFAULT_SETTINGS, DEFAULT_SPREAD, ENGINE_VERSION, HOUR_WINDOW, PRODUCTS, PRODUCT_ORDER, QUICK_SECONDS,
  SPREAD_FALLBACK, TAX_RATE, VERSION } from './config.js';
import { rng } from '../util.js';

const FORMATS = ['hour', 'session', 'quick'];
const SCENARIOS = ['跳空盤', '大波動盤', '趨勢盤', '盤整盤', '結算日'];
const KIND_NAME = { D: '日盤', N: '夜盤' };
const now = () => Date.now() / 1000;
const hmTs = ts => new Date(ts * 1000 + 8 * 3600e3).toISOString().slice(11, 16);
const randInt = n => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % n;
};
const deep = v => JSON.parse(JSON.stringify(v));

// ── 設定 ──
function getSettings() {
  const out = deep(DEFAULT_SETTINGS);
  for (const r of S.all('setting')) {
    const v = r.value;
    if (out[r.key] && typeof out[r.key] === 'object' && v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (out[r.key][k] && typeof out[r.key][k] === 'object' && x && typeof x === 'object') Object.assign(out[r.key][k], x);
        else out[r.key][k] = x;
      }
    } else out[r.key] = v;
  }
  return out;
}
async function putSettings(d) {
  await S.batch(tx => { for (const [k, v] of Object.entries(d || {})) if (k in DEFAULT_SETTINGS) tx.put('setting', { key: k, value: v }); });
}

// ── 價差 ──
function spreadTable() {
  const tab = { ...DEFAULT_SPREAD };
  for (const r of C.spreadRows()) tab[`${r.product}|${r.kind}|${r.near}`] = Math.max(1, Math.round(r.median));
  for (const [p, src] of Object.entries(SPREAD_FALLBACK))
    for (const k of ['D', 'N']) for (const nr of [0, 1])
      if (!(`${p}|${k}|${nr}` in tab) && `${src}|${k}|${nr}` in tab) tab[`${p}|${k}|${nr}`] = tab[`${src}|${k}|${nr}`];
  for (const p of Object.keys(PRODUCTS)) for (const k of ['D', 'N'])
    if (!(`${p}|${k}|1` in tab) && `${p}|${k}|0` in tab) tab[`${p}|${k}|1`] = Math.round(tab[`${p}|${k}|0`] * 1.5);
  return tab;
}

// ── 行情片段(games.py) ──
function mainSessions(product) {
  return C.sessions().filter(r => r.product === product && r.main).map(r => {
    const t = C.tag(r.sid) || {};
    return { ...r, tags: t.tags || [], gap: t.gap ?? null, rng: t.range ?? null, trend: t.trend ?? null };
  });
}
const seenIntervals = () => S.all('seen').map(r => [r.t0, r.t1]);
const overlaps = (a0, a1, ivs) => ivs.some(([b0, b1]) => a0 < b1 && b0 < a1);

function candidates(product, fmt, scenario = null) {
  const ss = mainSessions(product);
  const out = [];
  if (fmt === 'quick') {
    const by = {};
    for (const r of C.sessions()) if (r.product === product) (by[r.sid] ||= {})[r.month] = r;
    const days = [...new Set(ss.filter(r => r.kind === 'D').map(r => r.sid.slice(0, 8)))].sort();
    for (const d of days) {
      const dd = by[d + 'D'], nn = by[d + 'N'];
      if (!dd || !nn) continue;
      const both = Object.keys(dd).filter(m => m in nn);
      if (!both.length) continue;
      const month = both.reduce((best, m) => (dd[m].volume + nn[m].volume > dd[best].volume + nn[best].volume ? m : best));
      const a = dd[month], b = nn[month];
      out.push({ key: 'Q' + d, sids: [a.sid, b.sid], month, start: a.t0, end: b.t1, ranges: [[a.t0, a.t1], [b.t0, b.t1]],
        label: '日盤＋夜盤', date: a.date });
    }
    return out;
  }
  for (const r of ss) {
    if (scenario && !r.tags.includes(scenario)) continue;
    if (fmt === 'session' || scenario) {
      out.push({ key: 'S' + r.sid, sids: [r.sid], month: r.month, start: r.t0, end: r.t1, ranges: [[r.t0, r.t1]],
        label: KIND_NAME[r.kind], date: r.date, kind: r.kind });
    } else if (fmt === 'hour') {
      let k = 0, t = r.t0;
      while (t + HOUR_WINDOW <= r.t1 + 1) {
        out.push({ key: `H${r.sid}_${k}`, sids: [r.sid], month: r.month, start: t, end: t + HOUR_WINDOW, ranges: [[t, t + HOUR_WINDOW]],
          label: `${KIND_NAME[r.kind]} ${hmTs(t)}–${hmTs(t + HOUR_WINDOW)}`, date: r.date, kind: r.kind, window: k });
        t += HOUR_WINDOW; k++;
      }
    }
  }
  return out;
}

const playedKeys = cid => new Set(S.all('game').filter(g => g.contestant_id === cid).map(g => (g.spec || {}).key));

function available(c) {
  const st = getSettings();
  const human = c.kind === 'human';
  const ivs = human && st.unseen_rule !== false ? seenIntervals() : [];
  const mine = human ? new Set() : playedKeys(c.id);
  const count = cs => (human ? cs.filter(x => !x.ranges.some(([a, b]) => overlaps(a, b, ivs))).length : cs.filter(x => !mine.has(x.key)).length);
  const out = {};
  for (const f of FORMATS) { const cs = candidates(c.product, f); out[f] = { left: count(cs), total: cs.length }; }
  for (const sc of SCENARIOS) { const cs = candidates(c.product, 'session', sc); out[sc] = { left: count(cs), total: cs.length }; }
  return out;
}

function buildSpec(c, mode, fmt, cand, scenario = null) {
  const product = c.product;
  const st = getSettings();
  const spreads = spreadTable();
  const segs = cand.sids.map(sid => {
    const r = C.sessionRow(sid, product, cand.month);
    return { sid, kind: r.kind, date: r.date, file: r.file, t0: r.t0, t1: r.t1, near: r.near, spread: spreads[`${product}|${r.kind}|${r.near}`] ?? 4 };
  });
  const first = segs[0];
  const ctx = [];
  const prev = C.sessions().filter(r => r.product === product && r.t0 < first.t0).reduce((a, r) => (!a || r.t0 > a.t0 ? r : a), null);
  if (prev) {
    const r = C.sessionRow(prev.sid, product, cand.month) || C.sessions().find(x => x.sid === prev.sid && x.product === product && x.main);
    if (r) ctx.push({ sid: r.sid, kind: r.kind, date: r.date, file: r.file, t0: r.t0, t1: r.t1, same_month: r.month === cand.month });
  }
  const blind = mode === 'ranked' || mode === 'scenario';
  const seed = 1 + randInt(2 ** 31 - 1);
  const rand = rng(seed);
  const offset = blind && st.hide_price ? (Math.floor(rand() * 121) - 60) * 50 : 0;
  const t = C.tag(cand.sids[0]);
  return {
    key: cand.key, product, month: cand.month, mode, format: fmt, scenario, label: cand.label, date: cand.date,
    start: cand.start, end: cand.end, ranges: cand.ranges, segments: segs, context: ctx, blind, price_offset: offset, seed,
    fixed_seconds: fmt === 'quick' ? QUICK_SECONDS : null, at_open: Math.abs(cand.start - segs[0].t0) < 1,
    tags: t ? t.tags || [] : [],
    settings: Object.fromEntries(['latency_ms', 'fill_rule', 'level_gap', 'chase_pts', 'chase_sec'].map(k => [k, st[k]])),
    l1: st.l1[product] ?? 2, big_lots: st.big_lots[product] ?? 20, margin: st.margins[product],
    mult: PRODUCTS[product].mult, tick: PRODUCTS[product].tick, tax_rate: TAX_RATE, engine_version: ENGINE_VERSION,
  };
}

async function allocate(c, mode, fmt, scenario = null, pick = null) {
  const human = c.kind === 'human';
  const st = getSettings();
  if (mode === 'scenario') fmt = 'session';
  let cands = candidates(c.product, fmt, mode === 'scenario' ? scenario : null);
  let cand;
  if (mode === 'practice') {
    if (!pick) return [null, '練習場要先選日期'];
    cands = cands.filter(x => x.key === pick.key);
    if (!cands.length) return [null, '找不到這段行情'];
    cand = cands[0];
  } else {
    let pool;
    if (human) {
      const ivs = st.unseen_rule !== false ? seenIntervals() : [];
      pool = cands.filter(x => !x.ranges.some(([a, b]) => overlaps(a, b, ivs)));
    } else {
      const mine = playedKeys(c.id);
      pool = cands.filter(x => !mine.has(x.key));
      if (!pool.length) pool = cands;
    }
    if (!pool.length) return [null, '沒看過的行情用完了(每天收盤後會多新的;也可以到練習場)'];
    cand = pool[randInt(pool.length)];
  }
  const spec = buildSpec(c, mode, fmt, cand, mode === 'scenario' ? scenario : null);
  const gid = await S.batch(tx => {
    const id = tx.insert('game', { contestant_id: c.id, mode, format: fmt, scenario: spec.scenario, spec, seed: spec.seed, status: 'playing',
      started: now(), finished: null, engine_version: ENGINE_VERSION, params: spec.settings, orders: [], saved_t: null,
      summary: {}, monkey: [], equity: [], achievements: [] });
    if (human) for (const [a, b] of cand.ranges) tx.insert('seen', { t0: a, t1: b, game_id: id, at: now() });
    return id;
  });
  spec.game_id = gid;
  return [gid, spec];
}

function practiceList(product) {
  const ivs = seenIntervals();
  const out = { session: [], quick: [], hour: [] };
  for (const f of Object.keys(out))
    for (const c of candidates(product, f))
      out[f].push({ key: c.key, date: c.date, label: c.label, start: c.start, seen: c.ranges.some(([a, b]) => overlaps(a, b, ivs)) });
  return out;
}

// ── 參賽者／一局 ──
const contestants = () => S.all('contestant').filter(c => !c.archived).sort((a, b) => a.id - b.id);
const tradesOf = gid => S.all('trade').filter(t => t.game_id === gid).sort((a, b) => a.seq - b.seq);

function gameOut(g, full = true) {
  const out = { ...g };
  if (full) out.trades = tradesOf(g.id);
  else { delete out.orders; delete out.equity; }
  return out;
}

function cleanContestant(b) {
  const kind = b.kind === 'monkey' ? 'monkey' : 'human';
  const product = b.product in PRODUCTS ? b.product : 'MTX';
  const name = String(b.name || '').trim().slice(0, 20) || (kind === 'monkey' ? '隨機猴子' : '新參賽者');
  return { name, color: String(b.color || '#4f8cff').slice(0, 16), kind, product, capital: +b.capital || 1000000,
    commission: Math.max(0, +b.commission || 0), rules: b.rules || {}, strategy: b.strategy || {}, tags: b.tags || [], monkey: b.monkey || {} };
}

const TRADE_COLS = ['seq', 'dir', 'qty', 'entry_t', 'exit_t', 'entry_px', 'exit_px', 'points', 'gross', 'costs', 'pnl', 'mfe', 'mae',
  'risk', 'r', 'eff', 'hold', 'kind', 'hour', 'flags', 'tag', 'followed', 'note'];

async function finishGame(gid, b) {
  const g = S.get('game', gid);
  if (!g) return [{ error: '找不到這一局' }, 404];
  const old = tradesOf(gid);
  const have = new Set(S.all('achievement').filter(a => a.contestant_id === g.contestant_id).map(a => a.code));
  await S.batch(tx => {
    for (const t of old) tx.del('trade', t.id);
    for (const t of b.trades || []) {
      const row = { game_id: gid, contestant_id: g.contestant_id };
      for (const k of TRADE_COLS) row[k] = t[k] ?? (k === 'flags' ? {} : null);
      tx.insert('trade', row);
    }
    for (const code of b.achievements || []) {
      const c = String(code).slice(0, 40);
      if (!have.has(c)) tx.put('achievement', { contestant_id: g.contestant_id, code: c, game_id: gid, at: now() });
    }
    tx.put('game', { ...g, status: 'done', finished: now(), orders: b.orders || [], saved_t: b.saved_t ?? null, summary: b.summary || {},
      monkey: b.monkey || [], equity: b.equity || [], achievements: b.achievements || [] });
  });
  return [{ ok: true }, 200];
}

function overview() {
  const games = S.all('game');
  const done = games.filter(g => g.status === 'done').sort((a, b) => a.id - b.id);
  const meta = new Map(done.map(g => [g.id, g]));
  const ts = S.all('trade').filter(t => meta.has(t.game_id)).map(t => {
    const g = meta.get(t.game_id);
    return { ...t, mode: g.mode, format: g.format, scenario: g.scenario };
  }).sort((a, b) => a.entry_t - b.entry_t);
  return { contestants: contestants(), games: done.map(g => gameOut(g, false)), trades: ts, achievements: S.all('achievement') };
}

function catalog(product) {
  const ivs = seenIntervals();
  return mainSessions(product).map(r => ({ sid: r.sid, date: r.date, kind: r.kind, month: r.month, n: r.n, volume: r.volume, open: r.open,
    high: r.high, low: r.low, close: r.close, gap: r.gap, range: r.rng, trend: r.trend, tags: r.tags, near: r.near, seen: overlaps(r.t0, r.t1, ivs) }));
}

function dataStatus() {
  const ss = C.sessions();
  const sids = new Set(ss.map(r => r.sid));
  const dates = ss.map(r => r.date).sort();
  return { sessions: sids.size, first: dates[0] || null, last: dates[dates.length - 1] || null, quick_pairs: candidates('MTX', 'quick').length,
    updated: C.catalog().updated || null };
}

function jobStatus() {
  const u = C.updateInfo;
  return { state: u.checking ? 'busy' : 'ready', msg: u.checking ? '檢查新行情' : '就緒', done: 0, total: 0, last_check: u.last_check, error: u.error };
}

// ── 分派 ──
async function route(method, path, qs, body) {
  const p = path.replace(/\/+$/, '');
  let m;
  if (method === 'GET') {
    if (p === '/api/ping') return [{ ok: true, version: VERSION }, 200];
    if (p === '/api/status') {
      const cs = new Map(S.all('contestant').map(c => [c.id, c]));
      const act = S.all('game').filter(g => g.status === 'playing' && cs.get(g.contestant_id)?.kind === 'human').sort((a, b) => a.id - b.id)
        .map(g => ({ id: g.id, contestant_id: g.contestant_id, format: g.format, mode: g.mode, started: g.started, name: cs.get(g.contestant_id).name }));
      return [{ version: VERSION, job: jobStatus(), data: dataStatus(), active: act,
        sources: { tks: false, quotes: false, installed: false, mobile: true, persistent: S.isPersistent() },
        products: PRODUCTS, product_order: PRODUCT_ORDER, quick_seconds: QUICK_SECONDS }, 200];
    }
    if (p === '/api/settings') return [getSettings(), 200];
    if (p === '/api/contestants') return [contestants(), 200];
    if ((m = p.match(/^\/api\/contestant\/(\d+)$/))) { const c = S.get('contestant', +m[1]); return c ? [c, 200] : [{ error: '找不到參賽者' }, 404]; }
    if ((m = p.match(/^\/api\/available\/(\d+)$/))) { const c = S.get('contestant', +m[1]); return c ? [available(c), 200] : [{ error: '找不到參賽者' }, 404]; }
    if ((m = p.match(/^\/api\/practice\/(TX|MTX|TMF)$/))) return [practiceList(m[1]), 200];
    if ((m = p.match(/^\/api\/game\/(\d+)$/))) { const g = S.get('game', +m[1]); return g ? [gameOut(g), 200] : [{ error: '找不到這一局' }, 404]; }
    if (p === '/api/games') {
      const cid = +(qs.get('cid') || 0), lim = Math.min(+(qs.get('limit') || 200), 2000);
      return [S.all('game').filter(g => !cid || g.contestant_id === cid).sort((a, b) => b.id - a.id).slice(0, lim).map(g => gameOut(g, false)), 200];
    }
    if (p === '/api/overview') return [overview(), 200];
    if (p === '/api/catalog') { const pr = qs.get('product'); return [catalog(pr in PRODUCTS ? pr : 'MTX'), 200]; }
    if (p === '/api/spread') {
      const tab = spreadTable();
      return [{ calibration: [...C.spreadRows()].sort((a, b) => (a.product + a.kind + a.near).localeCompare(b.product + b.kind + b.near)),
        table: Object.entries(tab).sort().map(([k, v]) => { const [product, kind, near] = k.split('|'); return { product, kind, near: +near, spread: v }; }) }, 200];
    }
    if (p === '/api/backup') return [S.dump(), 200];
    return [{ error: '沒有這個 API' }, 404];
  }
  if (method === 'POST') {
    const b = body || {};
    if (p === '/api/settings') { await putSettings(b); return [getSettings(), 200]; }
    if (p === '/api/contestants') {
      const id = await S.insert('contestant', { ...cleanContestant(b), created: now(), archived: 0 });
      return [S.get('contestant', id), 200];
    }
    if ((m = p.match(/^\/api\/contestant\/(\d+)$/))) {
      const cid = +m[1], old = S.get('contestant', cid);
      if (!old) return [{ error: '找不到參賽者' }, 404];
      const v = cleanContestant(b);
      const played = S.all('game').some(g => g.contestant_id === cid);
      if (played && (v.kind !== old.kind || v.product !== old.product)) return [{ error: '已經比賽過的參賽者不能改類型或商品(戰績會混在一起);請複製一位新的' }, 400];
      await S.put('contestant', { ...old, ...v });
      return [S.get('contestant', cid), 200];
    }
    if ((m = p.match(/^\/api\/contestant\/(\d+)\/archive$/))) {
      const c = S.get('contestant', +m[1]);
      if (c) await S.put('contestant', { ...c, archived: 1 });
      return [{ ok: true }, 200];
    }
    if (p === '/api/game') {
      const c = S.get('contestant', +b.cid || 0);
      if (!c) return [{ error: '找不到參賽者' }, 404];
      const mode = ['ranked', 'scenario', 'practice'].includes(b.mode) ? b.mode : 'ranked';
      const fmt = FORMATS.includes(b.format) ? b.format : 'hour';
      const [gid, spec] = await allocate(c, mode, fmt, b.scenario, b.pick);
      return gid == null ? [{ error: spec }, 409] : [{ game_id: gid, spec }, 200];
    }
    if (p === '/api/monkey/plan') {
      const c = S.get('contestant', +b.cid || 0);
      if (!c || c.kind !== 'monkey') return [{ error: '只有電腦參賽者可以批次跑' }, 400];
      const fmt = FORMATS.includes(b.format) ? b.format : 'quick';
      const n = Math.max(1, Math.min(+b.count || 1, 300));
      const out = [];
      for (let i = 0; i < n; i++) {
        const [gid, spec] = await allocate(c, 'ranked', fmt);
        if (gid == null) break;
        out.push({ game_id: gid, spec });
      }
      return [out, 200];
    }
    if ((m = p.match(/^\/api\/game\/(\d+)\/autosave$/))) {
      const g = S.get('game', +m[1]);
      if (g && g.status === 'playing') await S.put('game', { ...g, orders: b.orders || [], saved_t: b.saved_t ?? null });
      return [{ ok: true }, 200];
    }
    if ((m = p.match(/^\/api\/game\/(\d+)\/finish$/))) return finishGame(+m[1], b);
    if ((m = p.match(/^\/api\/trade\/(\d+)$/))) {
      const t = S.get('trade', +m[1]);
      if (t) {
        for (const k of ['tag', 'followed', 'note']) if (k in b) t[k] = k === 'note' ? String(b[k] || '').slice(0, 500) : b[k];
        await S.put('trade', t);
      }
      return [{ ok: true }, 200];
    }
    if (p === '/api/download' || p === '/api/import') {
      C.refresh().then(ch => { if (!ch) window.dispatchEvent(new CustomEvent('arena:nodata', { detail: C.updateInfo.error })); });
      return [{ ok: true }, 200];
    }
    if (p === '/api/restore') { await S.restore(b); return [{ ok: true }, 200]; }
    return [{ error: '沒有這個 API' }, 404];
  }
  return [{ error: '不支援' }, 405];
}

let ready = null;
export function boot() {
  if (!ready) ready = Promise.all([S.init(), C.init()]);
  return ready;
}

export async function handle(method, url, body) {
  await boot();
  const u = new URL(url, location.href);
  const [out, code] = await route(method, u.pathname.replace(/^.*?(\/api\/)/, '/api/'), u.searchParams, body === undefined ? undefined : deep(body));
  return { ok: code < 400, code, data: deep(out) };
}
