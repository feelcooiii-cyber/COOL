# -*- coding: utf-8 -*-
"""台指競技場的設定:路徑、連接埠、商品規格與各種預設值。

畫面「設定」可以改的值(保證金、下單延遲、成交規則…)存在資料庫 setting 表,這裡只放預設值。
行情來源:有 TKS 的電腦讀 TKS 每天下載的期交所逐筆檔(唯讀);沒有 TKS(安裝版)就用內建資料,
並可以在畫面上直接向期交所下載最近 30 個交易日的逐筆檔(DOWNLOAD_DIR,匯入後刪掉 zip)。
環境變數(測試、示範用):ARENA_DATA 資料夾、ARENA_SESSIONS 行情檔資料夾、ARENA_PORT 固定連接埠、ARENA_NO_TKS=1 當作沒有 TKS。
"""
import os
from datetime import timedelta, timezone
from pathlib import Path

VERSION = "1.0.0"
ENGINE_VERSION = 1          # 撮合規則改了就加 1(每一局都記下當時的版本,之後可以用新版重算)

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
DATA = Path(os.environ.get("ARENA_DATA") or (ROOT / "data"))
SESS_DIR = Path(os.environ.get("ARENA_SESSIONS") or (DATA / "sessions"))   # 每一盤、每個商品月份一個逐筆檔(.bin)
DB = DATA / "arena.db"                # 參賽者、每一局、每一筆交易
SEED_DB = DATA / "seed.db"            # 安裝版附的行情目錄(啟動時併進 arena.db,不動參賽者與戰績)
QUOTES_DB = DATA / "quotes.db"        # 從 TKS 另存的台指期／小台真實買賣價(TKS 只留 7 天)
DOWNLOAD_DIR = DATA / "taifex_zip"    # 自己向期交所下載的逐筆檔(匯入後刪掉)
BACKUP_DIR = DATA / "backups"
LOG_DIR = DATA / "logs"
PORT_FILE = DATA / "port.txt"         # 伺服器實際用的連接埠(啟動程式讀這個)

HOST = "127.0.0.1"
PORT = int(os.environ.get("ARENA_PORT") or 5820)  # 避開 TKS(5800–5809)與大財寶(5666–5669)
PORTS = [PORT] if os.environ.get("ARENA_PORT") else list(range(5820, 5840))   # 被占用就往後找

TPE = timezone(timedelta(hours=8))

NO_TKS = bool(os.environ.get("ARENA_NO_TKS"))
TKS_ROOT = Path(r"C:\TKS看盤系統")
TAIFEX_ZIP_DIR = TKS_ROOT / "data" / "research" / "taifex_ticks" / "zip"
TKS_TICKS_DB = TKS_ROOT / "data" / "gw" / "tw_ticks.db"


def tks_available():
    return not NO_TKS and TAIFEX_ZIP_DIR.exists()


# 期交所公開的「期貨每筆成交資料」(只保留最近 30 個交易日;交易日傍晚之後才有當天的檔)
TAIFEX_URL = os.environ.get("ARENA_TAIFEX_URL") or \
    "https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_%s.zip"   # 環境變數只給測試用
DOWNLOAD_GAP = 2.0                    # 兩次下載間隔秒數
DOWNLOAD_DAYS = 50                    # 往回找幾個日曆日

# 商品:每點價值、跳動點、期交所公告的原始／維持保證金(2026-11-19 查詢;畫面「設定」可以改)
PRODUCTS = {
    "TX": {"name": "大台", "mult": 200, "tick": 1, "im": 701000, "mm": 538000, "big": 10, "l1": 2, "quote": "TX00"},
    "MTX": {"name": "小台", "mult": 50, "tick": 1, "im": 175250, "mm": 134500, "big": 20, "l1": 2, "quote": "MTX00"},
    "TMF": {"name": "微台", "mult": 10, "tick": 1, "im": 35050, "mm": 26900, "big": 50, "l1": 2, "quote": None},
}
PRODUCT_ORDER = ("MTX", "TX", "TMF")
TAX_RATE = 0.00002                    # 期交稅:股價指數期貨十萬分之二,每口每邊

# 典型買賣價差(點)。啟動時會用群益真實買賣價重新校準(quotes.calibrate),這裡是還沒有資料時的預設。
# near = 這個月份在一個交易日內就要到期(結算前一天、結算日),價差明顯放大。
DEFAULT_SPREAD = {
    ("TX", "D", 0): 5, ("TX", "N", 0): 6, ("TX", "D", 1): 10, ("TX", "N", 1): 8,
    ("MTX", "D", 0): 4, ("MTX", "N", 0): 3, ("MTX", "D", 1): 7, ("MTX", "N", 1): 4,
}
SPREAD_FALLBACK = {"TMF": "MTX"}      # 微台沒有買賣價紀錄,先借用小台

# 盤別:日盤 08:45–13:45、夜盤 15:00–次日 05:00
SESSION_HOURS = {"D": ((8, 45), 5 * 3600), "N": ((15, 0), 14 * 3600)}
HOUR_WINDOW = 3600                    # 一小時局
QUICK_SECONDS = 300                   # 快速局:5 分鐘走完一個日盤＋一個夜盤
MIN_BIN_TICKS = 300                   # 一盤裡成交少於這個筆數的月份不存

DEFAULT_SETTINGS = {
    "latency_ms": 200,                # 下單到交易所的延遲(市場時間)
    "fill_rule": "through",           # 限價單:through = 價格穿過才成交(保守);touch = 碰到就成交
    "level_gap": 1,                   # 超過最佳一檔的口數,每多一檔差幾點(沒有五檔資料,先用保守假設)
    "chase_pts": 30,                  # 進場前 chase_sec 秒內已經往進場方向走了這麼多點 → 算追價
    "chase_sec": 30,
    "sound": True,
    "hide_price": False,              # 正式賽把價位平移,避免認出是哪一天
    "unseen_rule": True,              # 正式賽只用沒看過的行情
    "smart_fast": True,
    "fast_speed": 30,                 # 智慧快轉:安靜時的倍速
    "move_pts": 15,                   # 智慧快轉:move_sec 秒內動超過這麼多點就放慢
    "move_sec": 20,
    "margins": {k: {"im": v["im"], "mm": v["mm"]} for k, v in PRODUCTS.items()},
    "big_lots": {k: v["big"] for k, v in PRODUCTS.items()},
    "l1": {k: v["l1"] for k, v in PRODUCTS.items()},
}
