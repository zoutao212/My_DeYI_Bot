@echo off
setlocal

set "REPO_DIR=D:\Git_GitHub\clawdbot"

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

pushd "%REPO_DIR%" || (
  echo ERROR: failed to enter "%REPO_DIR%".
  pause
  exit /b 1
)

echo [Rebuild-UI-And-Restart] Building Control UI...
pnpm ui:build
if errorlevel 1 (
  echo ERROR: ui:build failed.
  pause
  popd
  exit /b 1
)

echo.
echo [Rebuild-UI-And-Restart] Restarting gateway...
call Start-Clawdbot.cmd

popd
endlocal
