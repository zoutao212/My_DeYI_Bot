$ErrorActionPreference = 'Stop'

$RepoDir = $PSScriptRoot
$OriginUrl = 'https://github.com/zoutao212/clawdbot.git'
$UpstreamUrl = 'https://github.com/clawdbot/clawdbot.git'
$CustomBranch = 'custom/main'

if (-not (Test-Path -LiteralPath (Join-Path $RepoDir '.git'))) {
  Write-Host "ERROR: not a git repo: $RepoDir" -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host 'ERROR: git not found in PATH.' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

Set-Location -LiteralPath $RepoDir

Write-Host "Repo: $RepoDir" -ForegroundColor Cyan

Write-Host "Setting origin => $OriginUrl" -ForegroundColor Cyan
& git remote set-url origin $OriginUrl

$hasUpstream = $false
try {
  $existing = (& git remote) | ForEach-Object { $_.Trim() }
  $hasUpstream = $existing -contains 'upstream'
} catch {
  $hasUpstream = $false
}

if (-not $hasUpstream) {
  Write-Host "Adding upstream => $UpstreamUrl" -ForegroundColor Cyan
  & git remote add upstream $UpstreamUrl
} else {
  Write-Host "Updating upstream => $UpstreamUrl" -ForegroundColor Cyan
  & git remote set-url upstream $UpstreamUrl
}

Write-Host ''
& git remote -v

Write-Host ''
Write-Host "Creating/switching to $CustomBranch" -ForegroundColor Cyan
Write-Host ''
Write-Host 'Fetching upstream...' -ForegroundColor Cyan
& git fetch upstream

& git switch $CustomBranch
if ($LASTEXITCODE -ne 0) {
  Write-Host "Branch $CustomBranch does not exist; creating from upstream/main..." -ForegroundColor Yellow
  & git switch -c $CustomBranch upstream/main
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to create from upstream/main; creating from current HEAD..." -ForegroundColor Yellow
    & git switch -c $CustomBranch
  }
}

Write-Host ''
& git status -sb

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Read-Host 'Press Enter to exit'
