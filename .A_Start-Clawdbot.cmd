@echo off
setlocal

set "REPO_DIR=D:\Git_GitHub\clawdbot"
set CLAWDBOT_CLAUDE_SKIP_PERMISSIONS=1

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
call pnpm run clawdbot gateway stop
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
echo [Start-Clawdbot] Opening a new window for gateway logs...
start "Clawdbot Gateway" /D "%REPO_DIR%" cmd /k "pnpm run clawdbot gateway run --bind loopback --port 18789 --force"

echo [Start-Clawdbot] Waiting for gateway health...
set "OK="
for /l %%i in (1,1,15) do (
  call pnpm run clawdbot gateway health --bind loopback --port 18789 >nul 2>nul
  if not errorlevel 1 (
    set "OK=1"
    goto :health_ok
  )
  timeout /t 1 >nul
)

:health_ok
if defined OK (
  echo [Start-Clawdbot] Gateway is healthy. This window will close in 10 seconds...
  timeout /t 10 >nul
) else (
  echo [Start-Clawdbot] ERROR: Gateway did not become healthy.
  echo [Start-Clawdbot] Check the "Clawdbot Gateway" window for errors.
  pause
)
popd
endlocal
