@echo off
REM 打开带Token的Control UI
set "TOKEN=07f14e7c946cd9b4cd521eca7dc602e8560dcfbeb92c0013"
start "" "http://127.0.0.1:18789/?token=%TOKEN%"
echo Dashboard opened with token authentication
pause
