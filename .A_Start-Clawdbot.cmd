@echo off
REM Clawdbot Launcher
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0.A_Start-Clawdbot-Fixed-v2.ps1"
if errorlevel 1 (
    pause
    exit /b 1
)