# -*- coding: utf-8 -*-
"""驗證撮合用的報價模型:沒有買賣價時,用「最後一跳方向 + 典型價差」估賣一／買一,和群益真實買賣價比。

    py -3.12 -I arena\\validate.py

模型和 web\\js\\engine.js 一樣:最後一跳往上 → 賣一 = 最後價、買一 = 最後價 − 價差;往下反過來;
典型價差 = quotes.spread_table()(商品 × 日夜盤 × 是否快到期)。依時間加權,每一盤算一次。
"""
import sqlite3
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from arena import config, db, quotes  # noqa: E402
else:
    from . import config, db, quotes


def weighted_q(pairs, q):
    pairs = sorted(pairs)
    tot = sum(w for _, w in pairs)
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= tot * q:
            return v
    return None


def run():
    tab = quotes.spread_table()
    near = {(r["sid"], r["product"]) for r in db.rows(
        "SELECT s.sid, s.product FROM session s WHERE s.near = 1 AND s.month = "
        "(SELECT MIN(x.month) FROM session x WHERE x.sid = s.sid AND x.product = s.product)")}
    qc = sqlite3.connect("file:%s?mode=ro" % config.QUOTES_DB.as_posix(), uri=True)
    out = []
    for code, prod in quotes.CODES.items():
        rows = qc.execute("SELECT ts, bid, ask, px FROM quote WHERE code = ? ORDER BY ts", (code,)).fetchall()
        per = {}
        last, d = None, 0
        for (t0, b, a, px), (t1, *_r) in zip(rows, rows[1:]):
            if px and last is not None and px != last:
                d = 1 if px > last else -1
            if px:
                last = px
            s = quotes.session_of(t0)
            if not s or not (b and a and a > b and last and d):
                continue
            sid, kind = s
            nr = 1 if (sid, prod) in near else 0
            S = tab.get((prod, kind, nr), 4)
            ask = last if d > 0 else last + S
            bid = last if d < 0 else last - S
            w = min(t1 - t0, 60.0)
            e = per.setdefault((sid, kind, nr), {"ask": [], "bid": [], "naive": []})
            e["ask"].append((ask - a, w))
            e["bid"].append((bid - b, w))
            e["naive"].append((last - a, w))
        for (sid, kind, nr), e in sorted(per.items()):
            if len(e["ask"]) < 1000:
                continue
            def bias(lst):
                return sum(v * w for v, w in lst) / sum(w for _, w in lst)
            out.append({"product": prod, "sid": sid, "kind": kind, "near": nr, "spread": tab.get((prod, kind, nr)),
                        "ask_bias": bias(e["ask"]), "bid_bias": bias(e["bid"]), "naive_bias": bias(e["naive"]),
                        "ask_mae": weighted_q([(abs(v), w) for v, w in e["ask"]], 0.5),
                        "ask_p90": weighted_q([(abs(v), w) for v, w in e["ask"]], 0.9)})
    qc.close()
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    db.init()
    rs = run()
    for r in rs:
        print("%(product)-4s %(sid)s 快到期=%(near)d 價差 %(spread)s 點|估賣一偏差 %(ask_bias)+.2f、估買一偏差 %(bid_bias)+.2f、"
              "絕對誤差中位數 %(ask_mae)g、P90 %(ask_p90)g|直接用最後價 %(naive_bias)+.2f" % r)
    for prod in ("TX", "MTX"):
        sel = [r for r in rs if r["product"] == prod and not r["near"]]
        if sel:
            print("%s 一般盤 %d 盤:估賣一偏差 %+.2f ~ %+.2f;估買一偏差 %+.2f ~ %+.2f;直接用最後價 %+.2f ~ %+.2f" % (
                prod, len(sel), min(r["ask_bias"] for r in sel), max(r["ask_bias"] for r in sel),
                min(r["bid_bias"] for r in sel), max(r["bid_bias"] for r in sel),
                min(r["naive_bias"] for r in sel), max(r["naive_bias"] for r in sel)))


if __name__ == "__main__":
    main()
