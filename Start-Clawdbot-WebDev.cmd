@echo off
setlocal

set "REPO_DIR=D:\Git_GitHub\clawdbot"

echo [Start-Clawdbot-WebDev] Repo: "%REPO_DIR%"

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

pushd "%REPO_DIR%"
if errorlevel 1 (
  echo ERROR: failed to enter "%REPO_DIR%".
  pause
  exit /b 1
)

echo [Start-Clawdbot-WebDev] Stopping any running Gateway...
call pnpm run clawdbot gateway stop
echo [Start-Clawdbot-WebDev] gateway stop exit code: %ERRORLEVEL%
echo.

echo [Start-Clawdbot-WebDev] Starting UI dev server (hot reload)...
start "Clawdbot UI Dev" /D "%REPO_DIR%" cmd /k "pnpm ui:dev"

echo [Start-Clawdbot-WebDev] Starting Gateway in watch mode...
start "Clawdbot Gateway Dev" /D "%REPO_DIR%" cmd /k "pnpm gateway:watch run --bind loopback --port 18789 --verbose --ws-log compact"

echo [Start-Clawdbot-WebDev] Waiting for gateway health...
set "OK="
for /l %%i in (1,1,25) do (
  call pnpm run clawdbot gateway health --bind loopback --port 18789 >nul 2>nul
  if not errorlevel 1 (
    set "OK=1"
    goto :health_ok
  )
  timeout /t 1 >nul
)

:health_ok
if defined OK (
  echo [Start-Clawdbot-WebDev] Gateway is healthy.
  echo [Start-Clawdbot-WebDev] Opening Vite dev UI: http://localhost:5173/
  start "Clawdbot UI" http://localhost:5173/
  echo [Start-Clawdbot-WebDev] (Gateway static UI is still available at: http://127.0.0.1:18789/)
) else (
  echo [Start-Clawdbot-WebDev] ERROR: Gateway did not become healthy.
  echo [Start-Clawdbot-WebDev] Check the "Clawdbot Gateway Dev" window for errors.
  pause
)

popd
endlocal
