@echo off
setlocal

set "REPO_DIR=D:\Git_GitHub\clawdbot"
set "PS1=%REPO_DIR%\Uninstall-Clawdbot-Gateway-Service.ps1"

if not exist "%PS1%" (
  echo ERROR: not found: %PS1%
  pause
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
endlocal
