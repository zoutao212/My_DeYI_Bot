@echo off
setlocal

set "CFG=%USERPROFILE%\.clawdbot\clawdbot.json"

if not exist "%CFG%" (
  echo ERROR: config not found: "%CFG%"
  echo Run onboarding first: pnpm run clawdbot onboard
  pause
  exit /b 1
)

set "TOKEN="
set "PORT="

for /f "usebackq delims=" %%i in (`powershell.exe -NoProfile -Command "try { $cfg = Get-Content -Raw '%CFG%' | ConvertFrom-Json; $port = $cfg.gateway.port; $token = $cfg.gateway.auth.token; if ($null -ne $port) { Write-Output ('PORT=' + $port) }; if ($null -ne $token -and ($token.ToString().Trim().Length -gt 0)) { Write-Output ('TOKEN=' + $token) } } catch { }"`) do (
  for /f "tokens=1,* delims==" %%a in ("%%i") do (
    if /i "%%a"=="PORT" set "PORT=%%b"
    if /i "%%a"=="TOKEN" set "TOKEN=%%b"
  )
)

if not defined PORT set "PORT=18789"

if not defined TOKEN (
  set "URL=http://127.0.0.1:%PORT%/"
  echo WARNING: gateway token missing in config. Opening without token.
  echo If UI shows unauthorized, open a tokenized URL or paste token in UI settings.
) else (
  set "URL=http://127.0.0.1:%PORT%/?token=%TOKEN%"
)

start "Clawdbot" "%URL%"
echo Opened: %URL%
pause
endlocal
