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
  Write-Host 'ERROR: pnpm not found.' -ForegroundColor Red
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

Write-Host 'Stopping the Gateway service (if running)...' -ForegroundColor Cyan
try {
  pnpm run clawdbot gateway stop
} catch {
  Write-Host "Stop failed (maybe not running): $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Uninstalling the Gateway service...' -ForegroundColor Cyan
pnpm run clawdbot gateway uninstall

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Read-Host 'Press Enter to exit'
