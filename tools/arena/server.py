# -*- coding: utf-8 -*-
"""台指競技場本機伺服器:提供網頁、行情逐筆檔、存取參賽者與每一局的 API。只接受本機連線。

    台指競技場.exe(啟動程式)會用 runtime\\pythonw.exe 背景執行這支;開發時:
    py -3.12 -I arena\\server.py          # 前景執行(看紀錄)

已經有一個台指競技場在跑(data\\port.txt 的連接埠回應 ping)就直接結束;連接埠被別的程式占用就往後找(5820–5839),
實際用的連接埠寫在 data\\port.txt。
啟動後在背景:併入安裝版的行情目錄 → 備份資料庫 → 另存 TKS 的真實買賣價(有 TKS 才有)→ 匯入新的期交所逐筆檔
→ 校準價差;之後每 30 分鐘再檢查一次。沒有 TKS 的電腦可以在畫面上按「下載期交所最新行情」。
"""
import json
import logging
import logging.handlers
import re
import shutil
import sqlite3
import sys
import threading
import time
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from arena import config, db, games, importer, quotes, taifex  # noqa: E402
else:
    from . import config, db, games, importer, quotes, taifex

log = logging.getLogger("arena")
STATUS = {"state": "starting", "msg": "啟動中", "done": 0, "total": 0, "last_check": None, "error": None}
_job_lock = threading.Lock()

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
        ".bin": "application/octet-stream", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8"}
BIN_RE = re.compile(r"^[0-9]{8}[DN]_(TX|MTX|TMF)_[0-9]{6}\.bin$")
ALLOWED_HOSTS = set()                  # 綁定連接埠之後才知道
STOP = threading.Event()
SERVER = [None]


# ── 背景工作 ──
def backup():
    config.BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    dst = config.BACKUP_DIR / ("arena_%s.db" % datetime.now().strftime("%Y%m%d"))
    if dst.exists() or not config.DB.exists():
        return
    src = sqlite3.connect(str(config.DB))
    out = sqlite3.connect(str(dst))
    with out:
        src.backup(out)
    out.close()
    src.close()
    old = sorted(config.BACKUP_DIR.glob("arena_*.db"))
    for p in old[:-30]:
        p.unlink(missing_ok=True)


def data_job(first=False):
    if not _job_lock.acquire(blocking=False):
        return
    try:
        if first:
            STATUS.update(state="busy", msg="準備行情目錄")
            try:
                n = db.merge_seed()
                if n:
                    log.info("併入安裝版行情目錄 %d 列", n)
            except Exception as e:                      # noqa: BLE001
                log.warning("併入行情目錄失敗:%s", e)
            STATUS.update(state="busy", msg="備份資料庫")
            backup()
        STATUS.update(state="busy", msg="另存台指期／小台真實買賣價")
        try:
            got = quotes.archive()
            log.info("另存買賣價 %s", got)
        except Exception as e:                          # noqa: BLE001
            log.warning("另存買賣價失敗:%s", e)
        files = importer.pending_files()
        if files:
            STATUS.update(state="busy", msg="匯入期交所逐筆", done=0, total=len(files))
            importer.import_all(lambda d, t, name: STATUS.update(done=d, total=t, msg="匯入期交所逐筆 %s" % name))
            log.info("匯入 %d 個檔", len(files))
        if files or first:
            STATUS.update(msg="校準價差")
            try:
                quotes.calibrate()
            except Exception as e:                      # noqa: BLE001
                log.warning("校準價差失敗:%s", e)
        STATUS.update(state="ready", msg="就緒", error=None)
    except Exception as e:                              # noqa: BLE001
        log.exception("資料工作失敗")
        STATUS.update(state="error", msg="資料更新失敗", error=str(e))
    finally:
        STATUS["last_check"] = time.time()
        _job_lock.release()


def download_job():
    """向期交所下載最近缺的交易日(沒有 TKS 的電腦用)。"""
    if not _job_lock.acquire(blocking=False):
        return
    try:
        STATUS.update(state="busy", msg="檢查期交所有哪些新的日期", done=0, total=0, error=None)
        r = taifex.download_recent(lambda m, i, n: STATUS.update(msg=m, done=i, total=n), STOP)
        log.info("下載期交所 %s", r)
        STATUS["download"] = {"at": time.time(), **r}
        if r["got"]:
            STATUS.update(msg="校準價差")
            try:
                quotes.calibrate()
            except Exception as e:                      # noqa: BLE001
                log.warning("校準價差失敗:%s", e)
        STATUS.update(state="ready", msg="就緒" if r["got"] else "沒有新的行情可以下載", done=0, total=0)
    except Exception as e:                              # noqa: BLE001
        log.exception("下載期交所失敗")
        STATUS.update(state="error", msg="下載失敗(請確認網路)", error=str(e))
        STATUS["download"] = {"at": time.time(), "error": str(e)}
    finally:
        STATUS["last_check"] = time.time()
        _job_lock.release()


LAST_REQ = [time.time()]
IDLE_EXIT = 3 * 3600          # 3 小時沒有任何請求(視窗關了)就自己結束,下次從捷徑開會再啟動


def scheduler(stop, srv):
    data_job(first=True)
    n = 0
    while not stop.wait(60):
        n += 1
        if n % 30 == 0:
            data_job()
        if time.time() - LAST_REQ[0] > IDLE_EXIT and not _job_lock.locked():
            log.info("閒置 %d 秒,結束", int(time.time() - LAST_REQ[0]))
            threading.Thread(target=srv.shutdown, daemon=True).start()
            return


# ── API ──
def data_status():
    r = db.one("SELECT COUNT(DISTINCT sid) AS sessions, MIN(date) AS first, MAX(date) AS last FROM session")
    q = {p: len(games.candidates(p, "quick")) for p in config.PRODUCTS}
    return {"sessions": r["sessions"] if r else 0, "first": r["first"] if r else None, "last": r["last"] if r else None,
            "quick_pairs": q.get("MTX", 0)}


def sources():
    return {"tks": config.tks_available(), "quotes": config.QUOTES_DB.exists(),
            "installed": (config.ROOT / "runtime").exists(), "download": STATUS.get("download")}


def shutdown_later():
    def go():
        time.sleep(0.3)
        STOP.set()
        if SERVER[0]:
            SERVER[0].shutdown()
    threading.Thread(target=go, daemon=True).start()


def contestant_out(r):
    for k, d in (("rules", {}), ("strategy", {}), ("tags", []), ("monkey", {})):
        r[k] = db.jload(r.get(k), d)
    return r


def get_contestant(cid):
    r = db.one("SELECT * FROM contestant WHERE id = ?", (cid,))
    return contestant_out(r) if r else None


def game_out(r, full=True):
    out = dict(r)
    for k, d in (("spec", {}), ("params", {}), ("summary", {}), ("achievements", [])):
        out[k] = db.jload(r.get(k), d)
    if full:
        out["orders"] = db.jload(r.get("orders"), [])
        out["monkey"] = db.jload(r.get("monkey"), [])
        out["equity"] = db.jload(r.get("equity"), [])
        out["trades"] = db.rows("SELECT * FROM trade WHERE game_id = ? ORDER BY seq", (r["id"],))
        for t in out["trades"]:
            t["flags"] = db.jload(t.get("flags"), {})
    else:
        for k in ("orders", "equity"):
            out.pop(k, None)
        out["monkey"] = db.jload(r.get("monkey"), [])
    return out


def clean_contestant(b):
    kind = "monkey" if b.get("kind") == "monkey" else "human"
    product = b.get("product") if b.get("product") in config.PRODUCTS else "MTX"
    name = str(b.get("name") or "").strip()[:20] or ("隨機猴子" if kind == "monkey" else "新參賽者")
    return {
        "name": name, "color": str(b.get("color") or "#4f8cff")[:16], "kind": kind, "product": product,
        "capital": float(b.get("capital") or 1000000), "commission": max(0.0, float(b.get("commission") or 0)),
        "rules": db.jdump(b.get("rules") or {}), "strategy": db.jdump(b.get("strategy") or {}),
        "tags": db.jdump(b.get("tags") or []), "monkey": db.jdump(b.get("monkey") or {}),
    }


TRADE_COLS = ("seq", "dir", "qty", "entry_t", "exit_t", "entry_px", "exit_px", "points", "gross", "costs", "pnl", "mfe",
              "mae", "risk", "r", "eff", "hold", "kind", "hour", "flags", "tag", "followed", "note")


def finish_game(gid, b):
    g = db.one("SELECT * FROM game WHERE id = ?", (gid,))
    if not g:
        return {"error": "找不到這一局"}, 404
    c = db.connect()
    c.execute("DELETE FROM trade WHERE game_id = ?", (gid,))
    for t in b.get("trades") or []:
        vals = []
        for k in TRADE_COLS:
            v = t.get(k)
            if k == "flags":
                v = db.jdump(v or {})
            vals.append(v)
        c.execute("INSERT INTO trade(game_id, contestant_id, %s) VALUES(?,?,%s)" % (", ".join(TRADE_COLS), ",".join("?" * len(TRADE_COLS))),
                  [gid, g["contestant_id"]] + vals)
    for code in b.get("achievements") or []:
        c.execute("INSERT OR IGNORE INTO achievement(contestant_id, code, game_id, at) VALUES(?,?,?,?)",
                  (g["contestant_id"], str(code)[:40], gid, db.now()))
    c.execute("UPDATE game SET status = ?, finished = ?, orders = ?, saved_t = ?, summary = ?, monkey = ?, equity = ?,"
              " achievements = ? WHERE id = ?",
              ("done", db.now(), db.jdump(b.get("orders") or []), b.get("saved_t"), db.jdump(b.get("summary") or {}),
               db.jdump(b.get("monkey") or []), db.jdump(b.get("equity") or []), db.jdump(b.get("achievements") or []), gid))
    c.commit()
    return {"ok": True}, 200


def overview():
    cs = [contestant_out(r) for r in db.rows("SELECT * FROM contestant WHERE archived = 0 ORDER BY id")]
    gs = [game_out(r, full=False) for r in db.rows("SELECT * FROM game WHERE status = 'done' ORDER BY id")]
    ts = db.rows("SELECT t.*, g.mode AS mode, g.format AS format, g.scenario AS scenario FROM trade t "
                 "JOIN game g ON g.id = t.game_id WHERE g.status = 'done' ORDER BY t.entry_t")
    for t in ts:
        t["flags"] = db.jload(t.get("flags"), {})
    ach = db.rows("SELECT * FROM achievement")
    return {"contestants": cs, "games": gs, "trades": ts, "achievements": ach}


def catalog(product):
    ivs = games.seen_intervals()
    out = []
    for r in games.main_sessions(product):
        out.append({"sid": r["sid"], "date": r["date"], "kind": r["kind"], "month": r["month"], "n": r["n"],
                    "volume": r["volume"], "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"],
                    "gap": r["gap"], "range": r["rng"], "trend": r["trend"], "tags": r["tags"], "near": r["near"],
                    "seen": games.overlaps(r["t0"], r["t1"], ivs)})
    return out


def route(method, path, qs, body):
    """→ (dict, http 狀態)。"""
    p = path.rstrip("/")
    if method == "GET":
        if p == "/api/ping":
            return {"ok": True, "version": config.VERSION}, 200
        if p == "/api/status":
            act = db.rows("SELECT g.id, g.contestant_id, g.format, g.mode, g.started, c.name FROM game g JOIN contestant c "
                          "ON c.id = g.contestant_id WHERE g.status = 'playing' AND c.kind = 'human' ORDER BY g.id")
            return {"version": config.VERSION, "job": STATUS, "data": data_status(), "active": act, "sources": sources(),
                    "products": config.PRODUCTS, "product_order": config.PRODUCT_ORDER, "quick_seconds": config.QUICK_SECONDS}, 200
        if p == "/api/settings":
            return db.get_settings(), 200
        if p == "/api/contestants":
            return [contestant_out(r) for r in db.rows("SELECT * FROM contestant WHERE archived = 0 ORDER BY id")], 200
        m = re.fullmatch(r"/api/contestant/(\d+)", p)
        if m:
            c = get_contestant(int(m.group(1)))
            return (c, 200) if c else ({"error": "找不到參賽者"}, 404)
        m = re.fullmatch(r"/api/available/(\d+)", p)
        if m:
            c = get_contestant(int(m.group(1)))
            return (games.available(c), 200) if c else ({"error": "找不到參賽者"}, 404)
        m = re.fullmatch(r"/api/practice/(TX|MTX|TMF)", p)
        if m:
            return games.practice_list(m.group(1)), 200
        m = re.fullmatch(r"/api/game/(\d+)", p)
        if m:
            g = db.one("SELECT * FROM game WHERE id = ?", (int(m.group(1)),))
            return (game_out(g), 200) if g else ({"error": "找不到這一局"}, 404)
        if p == "/api/games":
            cid = int(qs.get("cid", ["0"])[0] or 0)
            lim = min(int(qs.get("limit", ["200"])[0] or 200), 2000)
            rs = db.rows("SELECT * FROM game WHERE (? = 0 OR contestant_id = ?) ORDER BY id DESC LIMIT ?", (cid, cid, lim))
            return [game_out(r, full=False) for r in rs], 200
        if p == "/api/overview":
            return overview(), 200
        if p == "/api/catalog":
            prod = qs.get("product", ["MTX"])[0]
            return catalog(prod if prod in config.PRODUCTS else "MTX"), 200
        if p == "/api/spread":
            tab = quotes.spread_table()
            return {"calibration": db.rows("SELECT * FROM spread ORDER BY product, kind, near"),
                    "table": [{"product": k[0], "kind": k[1], "near": k[2], "spread": v} for k, v in sorted(tab.items())]}, 200
        return {"error": "沒有這個 API"}, 404
    if method == "POST":
        if p == "/api/settings":
            db.put_settings(body or {})
            return db.get_settings(), 200
        if p == "/api/contestants":
            v = clean_contestant(body or {})
            cur = db.run("INSERT INTO contestant(name, color, kind, product, capital, commission, rules, strategy, tags, monkey,"
                         " created) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                         (v["name"], v["color"], v["kind"], v["product"], v["capital"], v["commission"], v["rules"],
                          v["strategy"], v["tags"], v["monkey"], db.now()))
            return get_contestant(cur.lastrowid), 200
        m = re.fullmatch(r"/api/contestant/(\d+)", p)
        if m:
            cid = int(m.group(1))
            old = get_contestant(cid)
            if not old:
                return {"error": "找不到參賽者"}, 404
            v = clean_contestant(body or {})
            played = db.one("SELECT COUNT(*) AS n FROM game WHERE contestant_id = ?", (cid,))["n"]
            if played and (v["kind"] != old["kind"] or v["product"] != old["product"]):
                return {"error": "已經比賽過的參賽者不能改類型或商品(戰績會混在一起);請複製一位新的"}, 400
            db.run("UPDATE contestant SET name=?, color=?, kind=?, product=?, capital=?, commission=?, rules=?, strategy=?,"
                   " tags=?, monkey=? WHERE id=?",
                   (v["name"], v["color"], v["kind"], v["product"], v["capital"], v["commission"], v["rules"], v["strategy"],
                    v["tags"], v["monkey"], cid))
            return get_contestant(cid), 200
        m = re.fullmatch(r"/api/contestant/(\d+)/archive", p)
        if m:
            db.run("UPDATE contestant SET archived = 1 WHERE id = ?", (int(m.group(1)),))
            return {"ok": True}, 200
        if p == "/api/game":
            b = body or {}
            c = get_contestant(int(b.get("cid") or 0))
            if not c:
                return {"error": "找不到參賽者"}, 404
            mode = b.get("mode") if b.get("mode") in ("ranked", "scenario", "practice") else "ranked"
            fmt = b.get("format") if b.get("format") in games.FORMATS else "hour"
            gid, spec = games.allocate(c, mode, fmt, b.get("scenario"), b.get("pick"))
            if gid is None:
                return {"error": spec}, 409
            return {"game_id": gid, "spec": spec}, 200
        if p == "/api/monkey/plan":
            b = body or {}
            c = get_contestant(int(b.get("cid") or 0))
            if not c or c["kind"] != "monkey":
                return {"error": "只有電腦參賽者可以批次跑"}, 400
            fmt = b.get("format") if b.get("format") in games.FORMATS else "quick"
            n = max(1, min(int(b.get("count") or 1), 300))
            out = []
            for _ in range(n):
                gid, spec = games.allocate(c, "ranked", fmt)
                if gid is None:
                    break
                out.append({"game_id": gid, "spec": spec})
            return out, 200
        m = re.fullmatch(r"/api/game/(\d+)/autosave", p)
        if m:
            b = body or {}
            db.run("UPDATE game SET orders = ?, saved_t = ? WHERE id = ? AND status = 'playing'",
                   (db.jdump(b.get("orders") or []), b.get("saved_t"), int(m.group(1))))
            return {"ok": True}, 200
        m = re.fullmatch(r"/api/game/(\d+)/finish", p)
        if m:
            return finish_game(int(m.group(1)), body or {})
        m = re.fullmatch(r"/api/trade/(\d+)", p)
        if m:
            b = body or {}
            sets, args = [], []
            for k in ("tag", "followed", "note"):
                if k in b:
                    sets.append("%s = ?" % k)
                    args.append(b[k] if k != "note" else str(b[k] or "")[:500])
            if sets:
                db.run("UPDATE trade SET %s WHERE id = ?" % ", ".join(sets), args + [int(m.group(1))])
            return {"ok": True}, 200
        if p == "/api/import":
            threading.Thread(target=data_job, daemon=True).start()
            return {"ok": True}, 200
        if p == "/api/download":
            if _job_lock.locked():
                return {"error": "資料正在更新中,請稍候"}, 409
            threading.Thread(target=download_job, daemon=True).start()
            return {"ok": True}, 200
        if p == "/api/shutdown":                    # 安裝／解除安裝程式要換檔案前先叫伺服器結束
            shutdown_later()
            return {"ok": True}, 200
        return {"error": "沒有這個 API"}, 404
    return {"error": "不支援"}, 405


class Handler(BaseHTTPRequestHandler):
    server_version = "Arena/" + config.VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):            # 不印每一個請求
        pass

    def _host_ok(self):
        LAST_REQ[0] = time.time()
        return (self.headers.get("Host") or "") in ALLOWED_HOSTS

    def _send(self, code, data, ctype, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _api(self, method):
        if self.headers.get("X-Arena") != "1":
            return self._json({"error": "缺少 X-Arena 標頭"}, 403)
        u = urlparse(self.path)
        body = None
        if method == "POST":
            n = int(self.headers.get("Content-Length") or 0)
            if n > 20 * 1024 * 1024:
                return self._json({"error": "資料太大"}, 413)
            raw = self.rfile.read(n) if n else b""
            try:
                body = json.loads(raw.decode("utf-8")) if raw else {}
            except ValueError:
                return self._json({"error": "JSON 格式錯誤"}, 400)
        try:
            out, code = route(method, u.path, parse_qs(u.query), body)
        except Exception as e:                      # noqa: BLE001
            log.error("API %s %s 失敗:%s\n%s", method, u.path, e, traceback.format_exc())
            out, code = {"error": "伺服器錯誤:%s" % e}, 500
        self._json(out, code)

    def _static(self):
        u = urlparse(self.path)
        path = u.path
        if path in ("", "/"):
            path = "/index.html"
        elif path.endswith("/"):
            path += "index.html"
        if path.startswith("/data/sessions/"):
            name = path.rsplit("/", 1)[-1]
            if not BIN_RE.match(name):
                return self._send(404, b"not found", MIME[".txt"])
            f = config.SESS_DIR / name
        else:
            rel = Path(path.lstrip("/"))
            if ".." in rel.parts:
                return self._send(404, b"not found", MIME[".txt"])
            f = (config.WEB / rel).resolve()
            if config.WEB.resolve() not in f.parents:
                return self._send(404, b"not found", MIME[".txt"])
        if not f.is_file():
            return self._send(404, b"not found", MIME[".txt"])
        self._send(200, f.read_bytes(), MIME.get(f.suffix.lower(), "application/octet-stream"))

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, b"forbidden", MIME[".txt"])
        if self.path.startswith("/api/"):
            return self._api("GET")
        return self._static()

    do_HEAD = do_GET

    def do_POST(self):
        if not self._host_ok():
            return self._send(403, b"forbidden", MIME[".txt"])
        if self.path.startswith("/api/"):
            return self._api("POST")
        return self._send(405, b"method not allowed", MIME[".txt"])


def setup_logging():
    config.LOG_DIR.mkdir(parents=True, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(config.LOG_DIR / "server.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(h)
    if sys.stdout is not None:
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:                            # noqa: BLE001
            pass


class Server(ThreadingHTTPServer):
    """Windows 的 SO_REUSEADDR 會讓兩個程式同時聽同一個連接埠,所以關掉,改用獨占。"""
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        import socket
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def already_running():
    """data\\port.txt 記的連接埠上已經有台指競技場在回應 → 那個連接埠;否則 None。"""
    try:
        port = int(config.PORT_FILE.read_text(encoding="ascii").strip())
    except (OSError, ValueError):
        return None
    import urllib.request
    try:
        req = urllib.request.Request("http://127.0.0.1:%d/api/ping" % port, headers={"X-Arena": "1"})
        with urllib.request.urlopen(req, timeout=1.5) as r:
            if json.loads(r.read().decode("utf-8")).get("ok"):
                return port
    except Exception:                                    # noqa: BLE001
        return None
    return None


def bind():
    for port in config.PORTS:
        try:
            return Server((config.HOST, port), Handler), port
        except OSError:
            continue
    return None, None


def main():
    setup_logging()
    db.init()
    other = already_running()
    if other:
        log.info("已經有一個台指競技場在跑(連接埠 %d),這個不啟動", other)
        return 0
    srv, port = bind()
    if not srv:
        log.error("連接埠 %d–%d 都被占用,無法啟動", config.PORTS[0], config.PORTS[-1])
        return 1
    SERVER[0] = srv
    ALLOWED_HOSTS.update({"127.0.0.1:%d" % port, "localhost:%d" % port})
    config.PORT_FILE.write_text(str(port), encoding="ascii")
    threading.Thread(target=scheduler, args=(STOP, srv), daemon=True).start()
    log.info("台指競技場 %s 啟動:http://%s:%d/", config.VERSION, config.HOST, port)
    if sys.stdout is not None:
        print("台指競技場 %s:http://%s:%d/" % (config.VERSION, config.HOST, port), flush=True)
    try:
        srv.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        srv.server_close()
        try:
            if config.PORT_FILE.read_text(encoding="ascii").strip() == str(port):
                config.PORT_FILE.unlink()
        except OSError:
            pass
        log.info("結束")
    return 0


if __name__ == "__main__":
    sys.exit(main())
