# -*- coding: utf-8 -*-
"""期交所逐筆成交 zip → 每一盤、每個商品月份一個逐筆檔(data\\sessions\\*.bin)＋行情目錄(session 表)。

輸入(唯讀):TKS 每天下載的 Daily_YYYY_MM_DD.zip。交易日 D 的檔 = 前一晚 15:00 起的夜盤＋D 的日盤。
只留大台 TX、小台 MTX、微台 TMF 的月契約(週契約、價差單不要)。

期交所檔的時間只到「秒」;同一秒裡的多筆照檔案順序平均分散在那一秒裡(例:同一秒 4 筆 → 125、375、625、875 毫秒)。
成交數量欄是「買賣合計」(B+S),口數 = 一半。開盤集合競價那一筆有 * 標記。

.bin 格式(little-endian):'ARN1'、筆數 n(uint32)、開盤時間 t0(float64,epoch 秒),
接著 int32 t[n](距開盤毫秒)、int32 px[n]、int32 lots[n]、uint8 flags[n](bit0 = 集合競價)。
"""
import io
import os
import struct
import sys
import zipfile
from array import array
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from arena import config, db  # noqa: E402
else:
    from . import config, db

HDR = struct.Struct("<4sId")
PRODS = frozenset(("TX", "MTX", "TMF"))
DAY0, NIGHT0 = 8 * 3600 + 45 * 60, 15 * 3600
assert array("i").itemsize == 4


def _prev_day(d, cache={}):
    v = cache.get(d)
    if v is None:
        v = (datetime.strptime(d, "%Y%m%d") - timedelta(days=1)).strftime("%Y%m%d")
        cache[d] = v
    return v


def parse_zip(path):
    """→ {(sid, prod, month): [secs, px, lots, flags]}。secs = 距開盤秒數。"""
    out = {}
    with zipfile.ZipFile(path) as zf:
        inner = [i for i in zf.infolist() if i.filename.lower().endswith(".csv")][0]
        with zf.open(inner) as f:
            text = io.TextIOWrapper(f, encoding="cp950", errors="replace", newline="")
            next(text, None)
            for line in text:
                p = line.split(",", 9)
                if len(p) < 6:
                    continue
                prod = p[1].strip()
                if prod not in PRODS:
                    continue
                month = p[2].strip()
                if len(month) != 6 or not month.isdigit():
                    continue
                try:
                    t = int(p[3])
                    px = int(round(float(p[4])))
                    q = int(float(p[5]))
                except ValueError:
                    continue
                d = p[0].strip()
                s = t // 10000 * 3600 + t // 100 % 100 * 60 + t % 100
                if 84500 <= t <= 134500:
                    sid, secs = d + "D", s - DAY0
                elif t >= 150000:
                    sid, secs = d + "N", s - NIGHT0
                elif t <= 50000:
                    sid, secs = _prev_day(d) + "N", s + 86400 - NIGHT0
                else:
                    continue
                key = (sid, prod, month)
                rec = out.get(key)
                if rec is None:
                    rec = out[key] = [array("i"), array("i"), array("i"), bytearray()]
                rec[0].append(secs)
                rec[1].append(px)
                rec[2].append((q + 1) // 2)
                rec[3].append(1 if len(p) > 8 and p[8].strip() == "*" else 0)
    return out


def session_t0(sid):
    d, kind = sid[:8], sid[8]
    (h, m), _ = config.SESSION_HOURS[kind]
    return datetime(int(d[:4]), int(d[4:6]), int(d[6:8]), h, m, tzinfo=config.TPE).timestamp()


def to_ms(secs):
    """距開盤秒數(同一秒照順序)→ 毫秒,同一秒的多筆平均分散。"""
    n = len(secs)
    ms = array("i", bytes(4 * n))
    i = 0
    while i < n:
        j = i
        s = secs[i]
        while j < n and secs[j] == s:
            j += 1
        k = j - i
        base = s * 1000
        for x in range(k):
            ms[i + x] = base + (x * 1000 + 500) // k
        i = j
    return ms


def write_bin(path, t0, ms, px, lots, flags):
    tmp = path.with_suffix(".part")
    with open(tmp, "wb") as f:
        f.write(HDR.pack(b"ARN1", len(ms), t0))
        f.write(ms.tobytes())
        f.write(px.tobytes())
        f.write(lots.tobytes())
        f.write(bytes(flags))
    os.replace(tmp, path)


def process_file(zpath, out_dir):
    """子行程:解析一個 zip、寫出 .bin,回傳目錄列。"""
    out_dir = Path(out_dir)
    parsed = parse_zip(zpath)
    rows = []
    for (sid, prod, month), (secs, px, lots, flags) in parsed.items():
        n = len(secs)
        if n < config.MIN_BIN_TICKS:
            continue
        if any(secs[i] > secs[i + 1] for i in range(n - 1)):        # 照時間排(穩定排序,同一秒保持檔案順序)
            order = sorted(range(n), key=secs.__getitem__)
            secs = array("i", (secs[i] for i in order))
            px = array("i", (px[i] for i in order))
            lots = array("i", (lots[i] for i in order))
            flags = bytearray(flags[i] for i in order)
        ms = to_ms(secs)
        t0 = session_t0(sid)
        name = "%s_%s_%s.bin" % (sid, prod, month)
        write_bin(out_dir / name, t0, ms, px, lots, flags)
        kind = sid[8]
        rows.append({
            "sid": sid, "product": prod, "month": month, "date": "%s-%s-%s" % (sid[:4], sid[4:6], sid[6:8]),
            "kind": kind, "t0": t0, "t1": t0 + config.SESSION_HOURS[kind][1], "n": n, "volume": sum(lots),
            "open": px[0], "high": max(px), "low": min(px), "close": px[-1],
            "first_t": t0 + ms[0] / 1000.0, "last_t": t0 + ms[-1] / 1000.0, "file": name,
        })
    return rows


def source_dirs():
    """要找期交所檔的資料夾:TKS 下載的(有 TKS 才有)、自己下載的。"""
    dirs = []
    if config.tks_available():
        dirs.append(config.TAIFEX_ZIP_DIR)
    if config.DOWNLOAD_DIR.exists():
        dirs.append(config.DOWNLOAD_DIR)
    return dirs


def pending_files():
    have = {r["file"]: r for r in db.rows("SELECT file, size, mtime FROM imported")}
    out, names = [], set()
    for d in source_dirs():
        for p in sorted(d.glob("Daily_*.zip")):
            if p.name in names:
                continue
            st = p.stat()
            h = have.get(p.name)
            if h and h["size"] == st.st_size and abs((h["mtime"] or 0) - st.st_mtime) < 1:
                continue
            if d == config.DOWNLOAD_DIR and h:                  # 自己下載的:檔名匯入過就不再匯入
                continue
            names.add(p.name)
            out.append(p)
    return out


def import_all(progress=None, workers=4):
    """匯入還沒匯入(或檔案變了)的期交所檔。progress(done, total, 檔名)。回傳新匯入的檔數。"""
    db.init()
    config.SESS_DIR.mkdir(parents=True, exist_ok=True)
    files = pending_files()
    if not files:
        return 0
    c = db.connect()
    done = 0
    workers = max(1, min(workers, len(files), os.cpu_count() or 1))
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(process_file, str(p), str(config.SESS_DIR)): p for p in files}
        from concurrent.futures import as_completed
        for fu in as_completed(futs):
            p = futs[fu]
            rows = fu.result()
            for r in rows:
                c.execute("INSERT OR REPLACE INTO session(sid, product, month, date, kind, t0, t1, n, volume, open, high,"
                          " low, close, first_t, last_t, main, near, file) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?)",
                          (r["sid"], r["product"], r["month"], r["date"], r["kind"], r["t0"], r["t1"], r["n"],
                           r["volume"], r["open"], r["high"], r["low"], r["close"], r["first_t"], r["last_t"], r["file"]))
            st = p.stat()
            c.execute("INSERT OR REPLACE INTO imported(file, size, mtime, at, rows) VALUES(?,?,?,?,?)",
                      (p.name, st.st_size, st.st_mtime, db.now(), len(rows)))
            c.commit()
            if p.parent == config.DOWNLOAD_DIR:                   # 自己下載的 zip 匯入後就刪掉(一天約 5 MB)
                p.unlink(missing_ok=True)
            done += 1
            if progress:
                progress(done, len(files), p.name)
    rebuild_catalog()
    return done


def third_wednesday(month):
    """'202611' → '2026-11-18'(該月第三個星期三)。"""
    y, m = int(month[:4]), int(month[4:6])
    first = datetime(y, m, 1)
    d = 1 + (2 - first.weekday()) % 7 + 14
    return "%04d-%02d-%02d" % (y, m, d)


def rebuild_catalog():
    """主力月份(每一盤每個商品成交量最大的月份)、快到期標記、盤型標籤。"""
    c = db.connect()
    c.execute("UPDATE session SET main = 0, near = 0")
    c.execute("UPDATE session SET main = 1 WHERE rowid IN (SELECT rowid FROM session s WHERE volume = "
              "(SELECT MAX(volume) FROM session x WHERE x.sid = s.sid AND x.product = s.product))")
    # 到期日:月契約在該月第三個星期三到期(遇假日順延到下一個交易日)= 那個日期起、這個月份還有成交的第一個日盤
    day_sids = [r[0] for r in c.execute("SELECT DISTINCT sid FROM session WHERE kind='D' ORDER BY t0")]
    expiry = {}
    for prod, month in c.execute("SELECT DISTINCT product, month FROM session").fetchall():
        d3 = third_wednesday(month)
        r = c.execute("SELECT sid FROM session WHERE product = ? AND month = ? AND kind = 'D' AND date >= ? ORDER BY t0 LIMIT 1",
                      (prod, month, d3)).fetchone()
        if r:
            expiry[(prod, month)] = r[0]
    for (prod, month), sid in expiry.items():
        i = day_sids.index(sid) if sid in day_sids else -1
        near = [sid] + ([day_sids[i - 1]] if i > 0 else [])
        for s in near:
            c.execute("UPDATE session SET near = 1 WHERE sid = ? AND product = ? AND month = ?", (s, prod, month))
    # 盤型(大台主力月份)
    c.execute("DELETE FROM session_tag")
    closes = {}
    exp_sids = {sid for (prod, _), sid in expiry.items() if prod == "TX"}
    for r in c.execute("SELECT sid, month, kind, open, high, low, close, main FROM session WHERE product='TX' ORDER BY t0, month").fetchall():
        sid, month, kind, o, h, l, cl, main = r
        if main:
            gap = o - closes[month] if month in closes else None
            rng = h - l
            trend = abs(cl - o) / rng if rng > 0 else 0.0
            tags = []
            if gap is not None and kind == "D" and abs(gap) >= 300:
                tags.append("跳空盤")
            if rng >= 1000:
                tags.append("大波動盤")
            if trend >= 0.6:
                tags.append("趨勢盤")
            elif trend <= 0.2:
                tags.append("盤整盤")
            if sid in exp_sids:
                tags.append("結算日")
            c.execute("INSERT OR REPLACE INTO session_tag(sid, gap, range, trend, tags, expiry) VALUES(?,?,?,?,?,?)",
                      (sid, gap, rng, trend, db.jdump(tags), 1 if sid in exp_sids else 0))
        closes[month] = cl
    c.commit()


def main(argv):
    sys.stdout.reconfigure(encoding="utf-8")
    db.init()
    if "--rebuild" in argv:
        rebuild_catalog()
        print("目錄重建完成")
        return
    if "--force" in argv:
        db.run("DELETE FROM imported")
    t = datetime.now()
    n = import_all(lambda d, total, name: print("  %d/%d %s" % (d, total, name), flush=True))
    print("匯入 %d 個檔,%.1f 秒" % (n, (datetime.now() - t).total_seconds()))
    for r in db.rows("SELECT product, COUNT(DISTINCT sid) AS s, SUM(n) AS n, MIN(date) AS a, MAX(date) AS b FROM session "
                     "WHERE main = 1 GROUP BY product"):
        print("  %(product)s 主力月份 %(s)d 盤、%(n)d 筆(%(a)s ~ %(b)s)" % r)


if __name__ == "__main__":
    main(sys.argv[1:])
