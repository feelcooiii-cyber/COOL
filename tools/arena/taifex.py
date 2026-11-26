# -*- coding: utf-8 -*-
"""向期交所下載最近的「期貨每筆成交資料」(Daily_YYYY_MM_DD.zip),給沒有 TKS 的電腦(安裝版)更新行情。

期交所只保留最近 30 個交易日,交易日傍晚之後才有當天的檔;假日、還沒出來、太舊的日期會回錯誤頁(不是 zip)就跳過。
只連 www.taifex.com.tw,兩次下載間隔 config.DOWNLOAD_GAP 秒;下載完交給 importer 匯入,匯入後刪掉 zip。

    py -3.12 -I arena\\taifex.py            # 命令列下載＋匯入
"""
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from arena import config, db, importer  # noqa: E402
else:
    from . import config, db, importer

UA = "Mozilla/5.0 (TaizhiArena)"


def candidate_dates(now=None):
    """還沒有的日期(週一到週五),從最後一天行情的隔天(或 DOWNLOAD_DAYS 天前)到今天。"""
    now = now or datetime.now(config.TPE)
    last = db.one("SELECT MAX(date) AS d FROM session WHERE kind = 'D'")
    have = {r["file"] for r in db.rows("SELECT file FROM imported")}
    start = now.date() - timedelta(days=config.DOWNLOAD_DAYS)
    if last and last["d"]:
        start = max(start, datetime.strptime(last["d"], "%Y-%m-%d").date() + timedelta(days=1))
    out = []
    d = start
    while d <= now.date():
        if d.weekday() < 5 and ("Daily_%s.zip" % d.strftime("%Y_%m_%d")) not in have:
            out.append(d)
        d += timedelta(days=1)
    return out


def fetch(day, dst_dir):
    """→ (檔案路徑或 None, 說明)。"""
    tag = day.strftime("%Y_%m_%d")
    url = config.TAIFEX_URL % tag
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        return None, "期交所回 %d" % e.code
    if data[:2] != b"PK":
        return None, "沒有這天的檔(假日、還沒出來或超過 30 天)"
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / ("Daily_%s.zip" % tag)
    tmp = dst.with_suffix(".part")
    tmp.write_bytes(data)
    os.replace(tmp, dst)
    return dst, "%.1f MB" % (len(data) / 1e6)


def download_recent(progress=None, stop=None):
    """下載缺的日期並匯入。progress(訊息, 第幾個, 共幾個)。回傳 {'got': n, 'skipped': n, 'imported': n, 'days': [...]}。"""
    db.init()
    days = candidate_dates()
    got, skipped, names = 0, 0, []
    for i, d in enumerate(days):
        if stop is not None and stop.is_set():
            break
        if progress:
            progress("下載期交所 %s" % d.isoformat(), i + 1, len(days))
        path, why = fetch(d, config.DOWNLOAD_DIR)
        if path:
            got += 1
            names.append(d.isoformat())
        else:
            skipped += 1
        if i + 1 < len(days):
            time.sleep(config.DOWNLOAD_GAP)
    n = 0
    if got:
        if progress:
            progress("匯入新下載的行情", len(days), len(days))
        n = importer.import_all()
    return {"got": got, "skipped": skipped, "imported": n, "days": names, "checked": len(days)}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    db.init()
    print("要檢查的日期:", [d.isoformat() for d in candidate_dates()])
    r = download_recent(lambda m, i, n: print("  %d/%d %s" % (i, n, m), flush=True))
    print(r)


if __name__ == "__main__":
    main()
