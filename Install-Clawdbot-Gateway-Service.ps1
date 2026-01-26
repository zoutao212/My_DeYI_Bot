$ErrorActionPreference = 'Stop'

$RepoDir = 'D:\Git_GitHub\clawdbot'

function Test-IsAdmin {
  $current = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($current)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Path -LiteralPath (Join-Path $RepoDir 'package.json'))) {
  Write-Host "ERROR: repo not found at '$RepoDir'" -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host 'ERROR: pnpm not found. Install pnpm first.' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

if (-not (Test-IsAdmin)) {
  Write-Host 'Re-launching as Administrator...' -ForegroundColor Yellow
  $args = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$PSCommandPath`""
  )
  Start-Process -Verb RunAs -FilePath 'powershell.exe' -ArgumentList $args
  exit 0
}

Set-Location -LiteralPath $RepoDir

Write-Host 'Installing Clawdbot Gateway as a Windows Scheduled Task...' -ForegroundColor Cyan

pnpm run clawdbot gateway install --runtime node --port 18789 --force

Write-Host ''
Write-Host 'Starting the service...' -ForegroundColor Cyan
pnpm run clawdbot gateway start

Write-Host ''
Write-Host 'Done. You can now double-click Gateway-Service-Start.cmd to start it later.' -ForegroundColor Green
Read-Host 'Press Enter to exit'
