@echo off
setlocal

set "REPO_DIR=D:\Git_GitHub\clawdbot"

echo [Start-Clawdbot] Repo: "%REPO_DIR%"

if not exist "%REPO_DIR%\package.json" (
  echo ERROR: repo not found at "%REPO_DIR%".
  pause
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm not found. Install it first, then try again.
  pause
  exit /b 1
)

for /f "delims=" %%i in ('where pnpm 2^>nul') do (
  echo [Start-Clawdbot] pnpm: %%i
  goto :pnpm_found
)
:pnpm_found

pushd "%REPO_DIR%"
if errorlevel 1 (
  echo ERROR: failed to enter "%REPO_DIR%".
  pause
  exit /b 1
)

echo [Start-Clawdbot] Stopping any running Gateway...
pnpm run clawdbot gateway stop
echo [Start-Clawdbot] gateway stop exit code: %ERRORLEVEL%
echo.

echo [Start-Clawdbot] Checking if port 18789 is still in use...
set "GATEWAY_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":18789[ ]" ^| findstr /i "LISTENING"') do (
  set "GATEWAY_PID=%%p"
  goto :have_pid
)
:have_pid

if defined GATEWAY_PID (
  echo [Start-Clawdbot] Port 18789 is in use by PID %GATEWAY_PID%. Killing it...
  taskkill /PID %GATEWAY_PID% /F >nul 2>nul
  timeout /t 2 >nul
)

echo [Start-Clawdbot] Starting Clawdbot Gateway...
echo [Start-Clawdbot] This window must stay open.
pnpm run clawdbot gateway run --bind loopback --port 18789 --force

echo.
echo Gateway exited.
pause
popd
endlocal
