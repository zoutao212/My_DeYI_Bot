@echo off
setlocal

set "REPO_DIR=D:\Git_GitHub\clawdbot"

where pnpm >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm not found.
  pause
  exit /b 1
)

pushd "%REPO_DIR%" || exit /b 1
pnpm run clawdbot gateway start
pause
popd
endlocal
