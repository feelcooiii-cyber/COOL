# -*- coding: utf-8 -*-
"""產生 web/sw.js(離線快取):列出 App 本體的檔案,版本 = 檔案內容的雜湊(程式改了,手機下次打開就會換新版)。

    python -I tools/build_sw.py
"""
import hashlib
import json
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"
SKIP_DIRS = ("data/", "manual/", "shop/")   # shop/ 是另一個網頁(預購頁),不歸 App 管
SKIP = {"sw.js", "tests.html"}

files = sorted(p.relative_to(WEB).as_posix() for p in WEB.rglob("*") if p.is_file())
shell = [f for f in files if not f.startswith(SKIP_DIRS) and f not in SKIP and not f.endswith(".ico")]
h = hashlib.sha256()
for f in shell:
    h.update(f.encode() + b"\0" + (WEB / f).read_bytes())
ver = h.hexdigest()[:10]

SW = """// 由 tools/build_sw.py 產生,不要手改
const VERSION = '%(ver)s';
const SHELL = 'arena-shell-' + VERSION;
const DATA = 'arena-data';               // 行情檔(.arz):下載過就一直留著
const FILES = %(files)s;

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
""" % {"ver": ver, "files": json.dumps(shell, ensure_ascii=False)}
(WEB / "sw.js").write_text(SW, encoding="utf-8")
print("sw.js 版本", ver, "檔案", len(shell))
