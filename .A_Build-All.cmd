@echo off
setlocal

set "REPO_DIR=D:\My_GitHub_001\clawdbot"

echo ========================================
echo   Clawdbot Full Build
echo ========================================
echo.

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

echo [Build-All] Step 1/2: Building main project (TypeScript)...
pnpm build
if errorlevel 1 (
  echo ERROR: pnpm build failed.
  pause
  popd
  exit /b 1
)

echo.
echo [Build-All] Step 2/2: Building Control UI...
pnpm ui:build
if errorlevel 1 (
  echo ERROR: ui:build failed.
  pause
  popd
  exit /b 1
)

echo.
echo ========================================
echo   Build completed successfully!
echo ========================================
echo.
echo You can now run Start-Clawdbot.cmd to start the gateway.
echo.

popd
endlocal
pause
