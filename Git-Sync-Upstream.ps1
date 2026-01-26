$ErrorActionPreference = 'Stop'

$RepoDir = $PSScriptRoot
$CustomBranch = 'custom/main'
$UpstreamBranch = 'upstream/main'

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

$remotes = (& git remote) | ForEach-Object { $_.Trim() }
if ($remotes -notcontains 'upstream') {
  Write-Host 'ERROR: missing remote "upstream". Run Git-Setup-Fork.cmd first.' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}
if ($remotes -notcontains 'origin') {
  Write-Host 'ERROR: missing remote "origin".' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host ''
Write-Host 'Fetching upstream...' -ForegroundColor Cyan
& git fetch upstream

Write-Host ''
Write-Host "Switching to $CustomBranch" -ForegroundColor Cyan
& git switch $CustomBranch
if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: branch $CustomBranch not found. Run Git-Setup-Fork.cmd first." -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

$stashName = "clawdbot-auto-stash-" + (Get-Date -Format "yyyyMMdd-HHmmss")
Write-Host ''
Write-Host 'Stashing local changes (including untracked files)...' -ForegroundColor Cyan
& git stash push -u -m $stashName

Write-Host ''
Write-Host "Merging $UpstreamBranch into $CustomBranch" -ForegroundColor Cyan
& git merge $UpstreamBranch
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host 'Merge failed (likely conflicts).' -ForegroundColor Yellow
  Write-Host 'Resolve conflicts, then run:' -ForegroundColor Yellow
  Write-Host '  git status' -ForegroundColor Yellow
  Write-Host '  git add <files>' -ForegroundColor Yellow
  Write-Host '  git commit' -ForegroundColor Yellow
  Write-Host ''
  Write-Host 'Your changes were stashed. To restore them later:' -ForegroundColor Yellow
  Write-Host '  git stash list' -ForegroundColor Yellow
  Write-Host '  git stash pop' -ForegroundColor Yellow
  Read-Host 'Press Enter to exit'
  exit 1
}

Write-Host ''
Write-Host 'Pushing to your fork (origin)...' -ForegroundColor Cyan
& git push

Write-Host ''
Write-Host 'Restoring stashed local changes...' -ForegroundColor Cyan
& git stash pop

Write-Host ''
& git status -sb

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Read-Host 'Press Enter to exit'
