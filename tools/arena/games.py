# -*- coding: utf-8 -*-
"""發局:從行情目錄抽一段行情、組成一局的規格(spec),記下真人看過的行情。

賽制(format):
  hour    一小時局:日盤切 5 段、夜盤切 14 段
  session 整盤:一個日盤或一個夜盤
  quick   快速局:同一天的日盤＋夜盤(1,140 根 1 分 K),固定 5 分鐘走完
模式(mode):ranked 正式賽、scenario 情境關卡(整盤,依盤型)、practice 練習場(自己挑)

正式賽和情境關卡:真人參賽者只會抽到「任何一位真人都沒看過」的行情(設定 unseen_rule 可以關)。
練習場自己挑日期,但挑了就算看過。電腦參賽者(隨機猴子)不記看過,只避開自己玩過的。
"""
import random

from . import config, db, quotes

FORMATS = ("hour", "session", "quick")
SCENARIOS = ("跳空盤", "大波動盤", "趨勢盤", "盤整盤", "結算日")
KIND_NAME = {"D": "日盤", "N": "夜盤"}


def _hm(ts):
    from datetime import datetime
    return datetime.fromtimestamp(ts, config.TPE).strftime("%H:%M")


def main_sessions(product):
    rs = db.rows("SELECT s.*, t.tags AS tags, t.gap AS gap, t.range AS rng, t.trend AS trend FROM session s "
                 "LEFT JOIN session_tag t ON t.sid = s.sid WHERE s.product = ? AND s.main = 1 ORDER BY s.t0", (product,))
    for r in rs:
        r["tags"] = db.jload(r["tags"], [])
    return rs


def session_row(sid, product, month):
    return db.one("SELECT * FROM session WHERE sid = ? AND product = ? AND month = ?", (sid, product, month))


def seen_intervals():
    return [(r["t0"], r["t1"]) for r in db.rows("SELECT t0, t1 FROM seen")]


def overlaps(a0, a1, ivs):
    return any(a0 < b1 and b0 < a1 for b0, b1 in ivs)


def candidates(product, fmt, scenario=None):
    """→ [{key, sid(s), month, start, end, label, kind}]:這個商品、賽制能玩的所有片段。"""
    ss = main_sessions(product)
    out = []
    if fmt == "quick":
        by = {}
        for r in db.rows("SELECT sid, month, volume, kind, date FROM session WHERE product = ?", (product,)):
            by.setdefault(r["sid"], {})[r["month"]] = r
        days = sorted({r["sid"][:8] for r in ss if r["kind"] == "D"})
        for d in days:
            dd, nn = by.get(d + "D"), by.get(d + "N")
            if not dd or not nn:
                continue
            both = [m for m in dd if m in nn]
            if not both:
                continue
            month = max(both, key=lambda m: dd[m]["volume"] + nn[m]["volume"])
            a, b = session_row(d + "D", product, month), session_row(d + "N", product, month)
            out.append({"key": "Q" + d, "sids": [a["sid"], b["sid"]], "month": month, "start": a["t0"], "end": b["t1"],
                        "ranges": [(a["t0"], a["t1"]), (b["t0"], b["t1"])], "label": "日盤＋夜盤", "date": a["date"]})
        return out
    for r in ss:
        if scenario and scenario not in r["tags"]:
            continue
        if fmt == "session" or scenario:
            out.append({"key": "S" + r["sid"], "sids": [r["sid"]], "month": r["month"], "start": r["t0"], "end": r["t1"],
                        "ranges": [(r["t0"], r["t1"])], "label": KIND_NAME[r["kind"]], "date": r["date"], "kind": r["kind"]})
        elif fmt == "hour":
            k = 0
            t = r["t0"]
            while t + config.HOUR_WINDOW <= r["t1"] + 1:
                out.append({"key": "H%s_%d" % (r["sid"], k), "sids": [r["sid"]], "month": r["month"], "start": t,
                            "end": t + config.HOUR_WINDOW, "ranges": [(t, t + config.HOUR_WINDOW)],
                            "label": "%s %s–%s" % (KIND_NAME[r["kind"]], _hm(t), _hm(t + config.HOUR_WINDOW)),
                            "date": r["date"], "kind": r["kind"], "window": k})
                t += config.HOUR_WINDOW
                k += 1
    return out


def played_keys(contestant_id):
    return {db.jload(r["spec"], {}).get("key") for r in db.rows("SELECT spec FROM game WHERE contestant_id = ?", (contestant_id,))}


def available(contestant):
    """各賽制、情境還有幾局可以玩(正式賽／情境:沒看過的)。"""
    product = contestant["product"]
    st = db.get_settings()
    human = contestant["kind"] == "human"
    ivs = seen_intervals() if (human and st.get("unseen_rule", True)) else []
    mine = played_keys(contestant["id"]) if not human else set()
    out = {}

    def count(c):
        if human:
            return sum(1 for x in c if not any(overlaps(a, b, ivs) for a, b in x["ranges"]))
        return sum(1 for x in c if x["key"] not in mine)

    for fmt in FORMATS:
        c = candidates(product, fmt)
        out[fmt] = {"left": count(c), "total": len(c)}
    for sc in SCENARIOS:
        c = candidates(product, "session", sc)
        out[sc] = {"left": count(c), "total": len(c)}
    return out


def build_spec(contestant, mode, fmt, cand, scenario=None, seed=None):
    product = contestant["product"]
    st = db.get_settings()
    spreads = quotes.spread_table()
    segs = []
    for sid in cand["sids"]:
        r = session_row(sid, product, cand["month"])
        segs.append({"sid": sid, "kind": r["kind"], "date": r["date"], "file": r["file"], "t0": r["t0"], "t1": r["t1"],
                     "near": r["near"], "spread": spreads.get((product, r["kind"], r["near"]), 4)})
    # 前一盤當背景(只畫圖,不能交易):同月份優先
    first = segs[0]
    ctx = []
    prev = db.one("SELECT sid, kind, date FROM session WHERE product = ? AND t0 < ? ORDER BY t0 DESC LIMIT 1", (product, first["t0"]))
    if prev:
        r = session_row(prev["sid"], product, cand["month"]) or db.one(
            "SELECT * FROM session WHERE sid = ? AND product = ? AND main = 1", (prev["sid"], product))
        if r:
            ctx.append({"sid": r["sid"], "kind": r["kind"], "date": r["date"], "file": r["file"], "t0": r["t0"], "t1": r["t1"],
                        "same_month": r["month"] == cand["month"]})
    blind = mode in ("ranked", "scenario")
    seed = seed if seed is not None else random.SystemRandom().randrange(1, 2 ** 31)
    rng = random.Random(seed)
    offset = 0
    if blind and st.get("hide_price"):
        offset = rng.randrange(-60, 61) * 50
    tags = db.one("SELECT tags, gap, range, trend FROM session_tag WHERE sid = ?", (cand["sids"][0],)) or {}
    return {
        "key": cand["key"], "product": product, "month": cand["month"], "mode": mode, "format": fmt, "scenario": scenario,
        "label": cand["label"], "date": cand["date"], "start": cand["start"], "end": cand["end"], "ranges": cand["ranges"],
        "segments": segs, "context": ctx, "blind": blind, "price_offset": offset, "seed": seed,
        "fixed_seconds": config.QUICK_SECONDS if fmt == "quick" else None,
        "at_open": abs(cand["start"] - segs[0]["t0"]) < 1,
        "tags": db.jload(tags.get("tags"), []) if tags else [],
        "settings": {k: st[k] for k in ("latency_ms", "fill_rule", "level_gap", "chase_pts", "chase_sec")},
        "l1": st["l1"].get(product, 2), "big_lots": st["big_lots"].get(product, 20),
        "margin": st["margins"].get(product), "mult": config.PRODUCTS[product]["mult"],
        "tick": config.PRODUCTS[product]["tick"], "tax_rate": config.TAX_RATE, "engine_version": config.ENGINE_VERSION,
    }


def allocate(contestant, mode, fmt, scenario=None, pick=None):
    """→ (game_id, spec);沒有可玩的片段 → (None, 原因)。"""
    product = contestant["product"]
    human = contestant["kind"] == "human"
    st = db.get_settings()
    if mode == "scenario":
        fmt = "session"
    cands = candidates(product, fmt, scenario if mode == "scenario" else None)
    if mode == "practice":
        if not pick:
            return None, "練習場要先選日期"
        want = pick.get("key")
        cands = [c for c in cands if c["key"] == want]
        if not cands:
            return None, "找不到這段行情"
        cand = cands[0]
    else:
        if human:
            ivs = seen_intervals() if st.get("unseen_rule", True) else []
            pool = [c for c in cands if not any(overlaps(a, b, ivs) for a, b in c["ranges"])]
        else:
            mine = played_keys(contestant["id"])
            pool = [c for c in cands if c["key"] not in mine] or cands
        if not pool:
            return None, "沒看過的行情用完了(每天收盤後會多新的;也可以到練習場)"
        cand = random.SystemRandom().choice(pool)
    spec = build_spec(contestant, mode, fmt, cand, scenario if mode == "scenario" else None)
    c = db.connect()
    cur = c.execute("INSERT INTO game(contestant_id, mode, format, scenario, spec, seed, status, started, engine_version, params,"
                    " orders, saved_t) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    (contestant["id"], mode, fmt, spec["scenario"], db.jdump(spec), spec["seed"], "playing", db.now(),
                     config.ENGINE_VERSION, db.jdump(spec["settings"]), "[]", None))
    gid = cur.lastrowid
    if human:
        for a, b in cand["ranges"]:
            c.execute("INSERT INTO seen(t0, t1, game_id, at) VALUES(?,?,?,?)", (a, b, gid, db.now()))
    c.commit()
    spec["game_id"] = gid
    return gid, spec


def practice_list(product):
    """練習場:所有可以挑的日期／片段(標出看過沒)。"""
    ivs = seen_intervals()
    out = {"session": [], "quick": [], "hour": []}
    for fmt in out:
        for c in candidates(product, fmt):
            out[fmt].append({"key": c["key"], "date": c["date"], "label": c["label"], "start": c["start"],
                             "seen": any(overlaps(a, b, ivs) for a, b in c["ranges"])})
    return out
