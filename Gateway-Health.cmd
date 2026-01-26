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

pushd "%REPO_DIR%" || exit /b 1
pnpm run clawdbot gateway health --bind loopback --port 18789
pause
popd
endlocal
