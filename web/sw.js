// 由 tools/build_sw.py 產生,不要手改
const VERSION = '5dc560f596';
const SHELL = 'arena-shell-' + VERSION;
const DATA = 'arena-data';               // 行情檔(.arz):下載過就一直留著
const FILES = [".nojekyll", "css/app.css", "img/icon-180.png", "img/icon-192.png", "img/icon-512.png", "img/icon-maskable-512.png", "img/icon.svg", "index.html", "js/api.js", "js/chart.js", "js/data.js", "js/engine.js", "js/game.js", "js/local/api.js", "js/local/catalog.js", "js/local/config.js", "js/local/store.js", "js/main.js", "js/monkey.js", "js/screens/board.js", "js/screens/contestant.js", "js/screens/data.js", "js/screens/journal.js", "js/screens/lobby.js", "js/screens/play.js", "js/screens/result.js", "js/screens/settings.js", "js/screens/start.js", "js/sound.js", "js/state.js", "js/stats.js", "js/ui.js", "js/util.js", "manifest.webmanifest", "vendor/lightweight-charts.js"];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(['./', ...FILES])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('arena-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  if (path.includes('/shop/')) return;                   // 預購頁不歸 App 管,照一般網頁
  if (path.endsWith('/data/catalog.json')) {             // 目錄:先問網路,沒網路用上次的
    e.respondWith(fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(DATA).then(c => c.put('data/catalog.json', cp)); } return r; })
      .catch(() => caches.open(DATA).then(c => c.match('data/catalog.json')).then(r => r || Response.error())));
    return;
  }
  if (path.includes('/data/sessions/')) {                // 行情檔:有就用手機裡的,沒有才下載並留著
    e.respondWith(caches.open(DATA).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }))));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));   // App 本體
});
