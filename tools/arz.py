# -*- coding: utf-8 -*-
"""電腦版行情檔(.bin, ARN1)→ 手機版行情檔(.arz, gzip 的 ARN2;時間、價格存差分),以及匯出行情目錄 catalog.json。

    python -I tools/arz.py <sessions 資料夾(.bin)> <catalog.db> <網站 data 資料夾>

只轉還沒轉過的檔;catalog.json 每次重寫。
"""
import gzip
import json
import os
import sqlite3
import struct
import sys
import time
from array import array
from pathlib import Path


def bin_to_arz(src, dst):
    b = Path(src).read_bytes()
    magic, n, t0 = struct.unpack_from("<4sId", b, 0)
    if magic != b"ARN1":
        raise ValueError("不是 ARN1:%s" % src)
    t = array("i", b[16:16 + 4 * n])
    px = array("i", b[16 + 4 * n:16 + 8 * n])
    dt, dp = array("i", t), array("i", px)
    for i in range(n - 1, 0, -1):
        dt[i] -= t[i - 1]
        dp[i] -= px[i - 1]
    raw = struct.pack("<4sId", b"ARN2", n, t0) + dt.tobytes() + dp.tobytes() + b[16 + 8 * n:]
    tmp = Path(str(dst) + ".part")
    with open(tmp, "wb") as f:
        f.write(gzip.compress(raw, 9, mtime=0))
    os.replace(tmp, dst)


def export_catalog(db_path, out_path):
    c = sqlite3.connect(str(db_path))
    c.row_factory = sqlite3.Row
    cols = ("sid", "product", "month", "date", "kind", "t0", "t1", "n", "volume", "open", "high", "low", "close", "main", "near", "file")
    ses = [{k: r[k] for k in cols} for r in c.execute("SELECT * FROM session ORDER BY t0, product, month")]
    tags = []
    for r in c.execute("SELECT * FROM session_tag ORDER BY sid"):
        tags.append({"sid": r["sid"], "gap": r["gap"], "range": r["range"], "trend": round(r["trend"], 4) if r["trend"] is not None else None,
                     "tags": json.loads(r["tags"] or "[]"), "expiry": r["expiry"]})
    spread = [dict(r) for r in c.execute("SELECT * FROM spread ORDER BY product, kind, near")]
    last = max((s["date"] for s in ses), default="")
    data = {"updated": "%s@%d" % (last, len(ses)), "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "sessions": ses, "tags": tags, "spread": spread}
    tmp = Path(str(out_path) + ".part")
    tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, out_path)
    return len(ses)


def main(argv):
    src, db_path, out = Path(argv[0]), Path(argv[1]), Path(argv[2])
    sd = out / "sessions"
    sd.mkdir(parents=True, exist_ok=True)
    n = 0
    for p in sorted(src.glob("*.bin")):
        dst = sd / (p.stem + ".arz")
        if not dst.exists():
            bin_to_arz(p, dst)
            n += 1
    k = export_catalog(db_path, out / "catalog.json")
    print("轉檔 %d 個,目錄 %d 列" % (n, k))


if __name__ == "__main__":
    main(sys.argv[1:])
