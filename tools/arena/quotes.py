# -*- coding: utf-8 -*-
"""台指期／小台真實買賣價:從 TKS 另存(TKS 只留 7 天),並用來校準撮合用的典型價差。

另存:讀 TKS 的 data\\gw\\tw_ticks.db(唯讀)quote 表裡 TX00、MTX00 的每一列(買一、賣一、量、成交價),
     只抄比上次新的部分到 data\\quotes.db。時間是 TKS 那台電腦的時鐘(比交易所慢幾秒),校準價差不受影響。
校準:每一盤算一次「依時間加權的價差中位數」,同一商品、盤別、是否快到期,再取各盤的中位數。

    py -3.12 -I arena\\quotes.py            # 另存＋校準
"""
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from arena import config, db  # noqa: E402
else:
    from . import config, db

CODES = {v["quote"]: k for k, v in config.PRODUCTS.items() if v["quote"]}


def qconnect():
    config.DATA.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(config.QUOTES_DB), timeout=15)
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE IF NOT EXISTS quote(code TEXT, ts REAL, bid REAL, ask REAL, bq INTEGER, aq INTEGER, px REAL)")
    c.execute("CREATE INDEX IF NOT EXISTS quote_code_ts ON quote(code, ts)")
    return c


def archive():
    """→ {代碼: 新抄的列數}。TKS 的資料庫不存在或打不開就回傳空的(不影響其他功能)。"""
    if config.NO_TKS or not config.TKS_TICKS_DB.exists():
        return {}
    src = sqlite3.connect("file:%s?mode=ro" % config.TKS_TICKS_DB.as_posix(), uri=True, timeout=15)
    dst = qconnect()
    out = {}
    try:
        for code in CODES:
            last = dst.execute("SELECT MAX(ts) FROM quote WHERE code = ?", (code,)).fetchone()[0] or 0
            cur = src.execute("SELECT ts, bid, ask, bq, aq, px FROM quote WHERE code = ? AND ts > ? ORDER BY ts", (code, last))
            n = 0
            while True:
                chunk = cur.fetchmany(50000)
                if not chunk:
                    break
                dst.executemany("INSERT INTO quote(code, ts, bid, ask, bq, aq, px) VALUES(?,?,?,?,?,?,?)",
                                [(code,) + tuple(r) for r in chunk])
                n += len(chunk)
            dst.commit()
            out[code] = n
    finally:
        src.close()
        dst.close()
    return out


def session_of(ts):
    """電腦時間 → (sid, kind),盤外回 None。"""
    d = datetime.fromtimestamp(ts, config.TPE)
    hm = d.hour * 100 + d.minute
    if 845 <= hm < 1345:
        return d.strftime("%Y%m%d") + "D", "D"
    if hm >= 1500:
        return d.strftime("%Y%m%d") + "N", "N"
    if hm < 500:
        from datetime import timedelta
        return (d - timedelta(days=1)).strftime("%Y%m%d") + "N", "N"
    return None


def weighted_median(pairs):
    pairs.sort()
    tot = sum(w for _, w in pairs)
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= tot / 2:
            return v
    return None


def calibrate():
    """→ 校準表 [{product, kind, near, median, n, days}],同時寫進 arena.db 的 spread 表。"""
    if not config.QUOTES_DB.exists():
        return []
    qc = qconnect()
    near = {(r["sid"], r["product"]) for r in db.rows(
        "SELECT s.sid, s.product FROM session s WHERE s.near = 1 AND s.month = "
        "(SELECT MIN(x.month) FROM session x WHERE x.sid = s.sid AND x.product = s.product)")}
    per = {}
    for code, prod in CODES.items():
        rows = qc.execute("SELECT ts, bid, ask FROM quote WHERE code = ? ORDER BY ts", (code,)).fetchall()
        cur_sid, pairs = None, []

        def flush():
            if cur_sid and len(pairs) > 1000:
                m = weighted_median(pairs)
                kind = cur_sid[8]
                per.setdefault((prod, kind, 1 if (cur_sid, prod) in near else 0), []).append((cur_sid, m))

        for (t0, b, a), (t1, _, _) in zip(rows, rows[1:]):
            s = session_of(t0)
            sid = s[0] if s else None
            if sid != cur_sid:
                flush()
                cur_sid, pairs = sid, []
            if sid and b and a and a > b:
                pairs.append((a - b, min(t1 - t0, 60.0)))
        flush()
    qc.close()
    out = []
    c = db.connect()
    c.execute("DELETE FROM spread")
    for (prod, kind, nr), lst in sorted(per.items()):
        ms = sorted(m for _, m in lst)
        med = ms[len(ms) // 2] if len(ms) % 2 else (ms[len(ms) // 2 - 1] + ms[len(ms) // 2]) / 2
        days = ",".join("%s=%g" % (sid, m) for sid, m in lst)
        c.execute("INSERT OR REPLACE INTO spread(product, kind, near, median, n, days) VALUES(?,?,?,?,?,?)",
                  (prod, kind, nr, med, len(lst), days))
        out.append({"product": prod, "kind": kind, "near": nr, "median": med, "n": len(lst), "days": days})
    c.commit()
    return out


def spread_table():
    """撮合用的典型價差(點,整數):校準值優先,沒有就用預設;微台借小台。"""
    tab = {k: v for k, v in config.DEFAULT_SPREAD.items()}
    for r in db.rows("SELECT product, kind, near, median FROM spread"):
        tab[(r["product"], r["kind"], r["near"])] = max(1, int(round(r["median"])))
    for prod, src in config.SPREAD_FALLBACK.items():
        for kind in ("D", "N"):
            for nr in (0, 1):
                if (prod, kind, nr) not in tab and (src, kind, nr) in tab:
                    tab[(prod, kind, nr)] = tab[(src, kind, nr)]
    for prod in config.PRODUCTS:                      # 快到期沒有校準資料 → 用一般值的 1.5 倍
        for kind in ("D", "N"):
            if (prod, kind, 1) not in tab and (prod, kind, 0) in tab:
                tab[(prod, kind, 1)] = int(round(tab[(prod, kind, 0)] * 1.5))
    return tab


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    db.init()
    print("另存:", archive())
    for r in calibrate():
        print("  %(product)s %(kind)s 快到期=%(near)d 典型價差 %(median)g 點(%(n)d 盤:%(days)s)" % r)
    print("撮合用:", {"%s%s%d" % k: v for k, v in sorted(spread_table().items())})


if __name__ == "__main__":
    main()
