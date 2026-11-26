# -*- coding: utf-8 -*-
"""每天的行情更新(給雲端排程跑,也可以自己在電腦上跑):

1. 用電腦版原本的程式(tools/arena/taifex.py)向期交所下載還沒有的交易日,匯入 pipeline/arena.db(只有行情目錄)。
2. 新產生的 .bin 轉成手機版的 .arz,放到 web/data/sessions/,並重寫 web/data/catalog.json。

    python -I tools/update.py
"""
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    tmp = Path(tempfile.mkdtemp(prefix="arena_bins_"))
    os.environ["ARENA_DATA"] = str(ROOT / "pipeline")
    os.environ["ARENA_SESSIONS"] = str(tmp)
    os.environ["ARENA_NO_TKS"] = "1"
    sys.path.insert(0, str(ROOT / "tools"))
    from arena import db, taifex  # noqa: E402  (環境變數要先設好)
    import arz  # noqa: E402
    db.init()
    print("要檢查的日期:", [d.isoformat() for d in taifex.candidate_dates()])
    r = taifex.download_recent(lambda m, i, n: print("  %d/%d %s" % (i, n, m), flush=True))
    print(r)
    out = ROOT / "web" / "data"
    arz.main([str(tmp), str(ROOT / "pipeline" / "arena.db"), str(out)])
    # 給排程判斷要不要提交
    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            f.write("got=%d\n" % r["got"])


if __name__ == "__main__":
    main()
