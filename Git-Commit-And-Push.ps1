$ErrorActionPreference = 'Stop'

$RepoDir = $PSScriptRoot
$Branch = 'custom/main'

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

# Abort early if index is in a conflicted state.
& git diff --name-only --diff-filter=U *> $null
if ($LASTEXITCODE -eq 0) {
  $conflicts = & git diff --name-only --diff-filter=U
  if ($conflicts -and $conflicts.Count -gt 0) {
    Write-Host 'ERROR: merge conflicts detected. Resolve them first:' -ForegroundColor Red
    & git status
    Read-Host 'Press Enter to exit'
    exit 1
  }
}

& git switch $Branch
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: branch $Branch not found. Run Git-Setup-Fork.cmd first." -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host ''
& git status -sb

Write-Host ''
$Message = Read-Host 'Commit message'
if (-not $Message -or $Message.Trim().Length -eq 0) {
  Write-Host 'ERROR: commit message is required.' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host ''
Write-Host 'Staging all changes (git add -A)...' -ForegroundColor Cyan
& git add -A

Write-Host ''
Write-Host 'Committing...' -ForegroundColor Cyan
& git commit -m $Message
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'Commit failed. If there were no changes, this is normal.' -ForegroundColor Yellow
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host ''
Write-Host 'Pushing...' -ForegroundColor Cyan
& git push

Write-Host ''
& git status -sb

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Read-Host 'Press Enter to exit'
