# -*- coding: utf-8 -*-
"""資料庫(data\\arena.db):行情目錄、參賽者、每一局、每一筆交易、看過的行情、成就、設定。

每個執行緒自己開連線(sqlite3 連線不能跨執行緒);WAL 模式,讀寫不互卡。
"""
import json
import sqlite3
import threading
import time

from . import config

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)",
    # 匯入過的期交所檔(檔名、大小、修改時間;變了就重匯)
    "CREATE TABLE IF NOT EXISTS imported(file TEXT PRIMARY KEY, size INTEGER, mtime REAL, at REAL, rows INTEGER)",
    # 每一盤 × 商品 × 月份:sid = 20261117N(11/17 15:00 開始的夜盤)/ 20261118D(11/18 日盤)
    "CREATE TABLE IF NOT EXISTS session(sid TEXT, product TEXT, month TEXT, date TEXT, kind TEXT, t0 REAL, t1 REAL,"
    " n INTEGER, volume INTEGER, open REAL, high REAL, low REAL, close REAL, first_t REAL, last_t REAL, main INTEGER,"
    " near INTEGER DEFAULT 0, file TEXT, PRIMARY KEY(sid, product, month))",
    "CREATE INDEX IF NOT EXISTS session_t0 ON session(t0)",
    # 盤型(用大台主力月份算):跳空、高低差、收開差占高低差比例、標籤
    "CREATE TABLE IF NOT EXISTS session_tag(sid TEXT PRIMARY KEY, gap REAL, range REAL, trend REAL, tags TEXT, expiry INTEGER)",
    "CREATE TABLE IF NOT EXISTS contestant(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, color TEXT, kind TEXT,"
    " product TEXT, capital REAL, commission REAL, rules TEXT, strategy TEXT, tags TEXT, monkey TEXT, created REAL,"
    " archived INTEGER DEFAULT 0)",
    # 一局:spec = 行情片段與規格;orders = 每一個操作(可以重算);summary = 結算數字
    "CREATE TABLE IF NOT EXISTS game(id INTEGER PRIMARY KEY AUTOINCREMENT, contestant_id INTEGER, mode TEXT, format TEXT,"
    " scenario TEXT, spec TEXT, seed INTEGER, status TEXT, started REAL, finished REAL, engine_version INTEGER,"
    " params TEXT, orders TEXT, saved_t REAL, summary TEXT, monkey TEXT, equity TEXT, achievements TEXT)",
    "CREATE INDEX IF NOT EXISTS game_c ON game(contestant_id)",
    "CREATE TABLE IF NOT EXISTS trade(id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER, contestant_id INTEGER,"
    " seq INTEGER, dir INTEGER, qty INTEGER, entry_t REAL, exit_t REAL, entry_px REAL, exit_px REAL, points REAL,"
    " gross REAL, costs REAL, pnl REAL, mfe REAL, mae REAL, risk REAL, r REAL, eff REAL, hold REAL, kind TEXT,"
    " hour INTEGER, flags TEXT, tag TEXT, followed INTEGER, note TEXT)",
    "CREATE INDEX IF NOT EXISTS trade_g ON trade(game_id)",
    "CREATE INDEX IF NOT EXISTS trade_c ON trade(contestant_id)",
    # 看過的行情(真人參賽者玩過的時間範圍;正式賽不再抽到)
    "CREATE TABLE IF NOT EXISTS seen(id INTEGER PRIMARY KEY AUTOINCREMENT, t0 REAL, t1 REAL, game_id INTEGER, at REAL)",
    "CREATE TABLE IF NOT EXISTS achievement(contestant_id INTEGER, code TEXT, game_id INTEGER, at REAL,"
    " PRIMARY KEY(contestant_id, code))",
    "CREATE TABLE IF NOT EXISTS setting(key TEXT PRIMARY KEY, value TEXT)",
    # 價差校準:商品、盤別、是否快到期 → 典型價差(各盤時間加權中位數的中位數)
    "CREATE TABLE IF NOT EXISTS spread(product TEXT, kind TEXT, near INTEGER, median REAL, n INTEGER, days TEXT,"
    " PRIMARY KEY(product, kind, near))",
)

_local = threading.local()
_lock = threading.Lock()


def connect():
    c = getattr(_local, "conn", None)
    if c is None:
        config.DATA.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(str(config.DB), timeout=15)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA foreign_keys=OFF")
        _local.conn = c
    return c


def init():
    c = connect()
    with _lock:
        for s in SCHEMA:
            c.execute(s)
        c.commit()


def rows(sql, args=()):
    return [dict(r) for r in connect().execute(sql, args).fetchall()]


def one(sql, args=()):
    r = connect().execute(sql, args).fetchone()
    return dict(r) if r else None


def run(sql, args=()):
    c = connect()
    cur = c.execute(sql, args)
    c.commit()
    return cur


def jload(s, default=None):
    if s is None or s == "":
        return default
    try:
        return json.loads(s)
    except (TypeError, ValueError):
        return default


def jdump(v):
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def merge_seed():
    """安裝版:把 seed.db(附在安裝檔裡的行情目錄)併進 arena.db,參賽者與戰績不動。seed 沒變就不重做。"""
    p = config.SEED_DB
    if not p.exists():
        return 0
    st = p.stat()
    stamp = "%d:%d" % (st.st_size, int(st.st_mtime))
    c = connect()
    r = c.execute("SELECT value FROM meta WHERE key = 'seed'").fetchone()
    if r and r[0] == stamp:
        return 0
    c.commit()
    c.execute("ATTACH DATABASE ? AS seed", (str(p),))
    n = 0
    try:
        for t in ("session", "session_tag", "spread", "imported"):
            cols = [x[1] for x in c.execute("PRAGMA main.table_info(%s)" % t)]
            scols = {x[1] for x in c.execute("PRAGMA seed.table_info(%s)" % t)}
            use = [x for x in cols if x in scols]
            if not use:
                continue
            cl = ", ".join(use)
            n += c.execute("INSERT OR REPLACE INTO main.%s(%s) SELECT %s FROM seed.%s" % (t, cl, cl, t)).rowcount
        c.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('seed', ?)", (stamp,))
        c.commit()
    finally:
        c.execute("DETACH DATABASE seed")
    return n


def get_settings():
    out = json.loads(json.dumps(config.DEFAULT_SETTINGS))
    for r in connect().execute("SELECT key, value FROM setting"):
        v = jload(r["value"])
        if isinstance(out.get(r["key"]), dict) and isinstance(v, dict):
            for k, x in v.items():
                if isinstance(out[r["key"]].get(k), dict) and isinstance(x, dict):
                    out[r["key"]][k].update(x)
                else:
                    out[r["key"]][k] = x
        else:
            out[r["key"]] = v
    return out


def put_settings(d):
    c = connect()
    for k, v in d.items():
        if k in config.DEFAULT_SETTINGS:
            c.execute("INSERT OR REPLACE INTO setting(key, value) VALUES(?, ?)", (k, jdump(v)))
    c.commit()


def now():
    return time.time()
