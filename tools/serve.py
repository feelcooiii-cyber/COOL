# -*- coding: utf-8 -*-
"""在電腦上開一個小網站,讓同一個 Wi-Fi 的手機用瀏覽器試玩手機版(測試用)。

    python tools/serve.py          → 手機打開畫面上印出的網址
注意:用 http://區網IP 開時,「加到主畫面＋離線」不會啟用(瀏覽器規定要 https);其他功能都一樣。
"""
import functools
import http.server
import socket
from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "web"
PORT = 8800


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".webmanifest": "application/manifest+json", ".arz": "application/octet-stream"}

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    srv = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), functools.partial(H, directory=str(WEB)))
    print("台指競技場手機版測試中,手機(同一個 Wi-Fi)打開: http://%s:%d/" % (lan_ip(), PORT))
    print("關掉這個視窗就停止。")
    srv.serve_forever()
