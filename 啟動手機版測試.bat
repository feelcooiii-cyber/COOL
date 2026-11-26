@echo off
chcp 65001 >nul
cd /d "%~dp0"
py -3 tools\serve.py 2>nul || python tools\serve.py
pause
