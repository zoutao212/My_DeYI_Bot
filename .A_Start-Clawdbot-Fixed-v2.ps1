# Clawdbot Quick Start Script - Version 2
$ErrorActionPreference = "Stop"
$RepoDir = "D:\Git_GitHub\clawdbot"
$env:CLAWDBOT_CLAUDE_SKIP_PERMISSIONS = "1"

Write-Host "[Start-Clawdbot] Repo: $RepoDir" -ForegroundColor Cyan

# Check repo directory
if (-not (Test-Path "$RepoDir\package.json")) {
    Write-Host "[Start-Clawdbot] ERROR: repo not found at $RepoDir" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Check pnpm
$pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmPath) {
    Write-Host "[Start-Clawdbot] ERROR: pnpm not found" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[Start-Clawdbot] pnpm: $($pnpmPath.Source)" -ForegroundColor Gray

# Switch to repo directory
Push-Location $RepoDir

try {
    # Smart build detection
    Write-Host "[Start-Clawdbot] Checking if build is needed..." -ForegroundColor Cyan
    
    $needBuild = $false
    $needUiBuild = $false
    $distEntry = Join-Path $RepoDir "dist\entry.js"
    $buildStamp = Join-Path $RepoDir "dist\.buildstamp"
    $controlUiIndex = Join-Path $RepoDir "dist\control-ui\index.html"
    
    # Check TypeScript build
    if (-not (Test-Path $distEntry)) {
        Write-Host "[Start-Clawdbot] Build needed: dist\entry.js not found" -ForegroundColor Yellow
        $needBuild = $true
    }
    elseif (-not (Test-Path $buildStamp)) {
        Write-Host "[Start-Clawdbot] Build needed: .buildstamp not found" -ForegroundColor Yellow
        $needBuild = $true
    }
    
    # Check UI build
    if (-not (Test-Path $controlUiIndex)) {
        Write-Host "[Start-Clawdbot] UI Build needed: control-ui\index.html not found" -ForegroundColor Yellow
        $needUiBuild = $true
    }
    
    # Execute TypeScript build if needed
    if ($needBuild) {
        Write-Host "[Start-Clawdbot] Building TypeScript..." -ForegroundColor Yellow
        & pnpm build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[Start-Clawdbot] ERROR: TypeScript build failed" -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }
        Write-Host "[Start-Clawdbot] TypeScript build completed successfully" -ForegroundColor Green
    }
    else {
        Write-Host "[Start-Clawdbot] TypeScript build is up-to-date, skipping" -ForegroundColor Green
    }
    
    # Execute UI build if needed
    if ($needUiBuild) {
        Write-Host "[Start-Clawdbot] Building Control UI..." -ForegroundColor Yellow
        & pnpm ui:build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[Start-Clawdbot] ERROR: UI build failed" -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }
        Write-Host "[Start-Clawdbot] UI build completed successfully" -ForegroundColor Green
    }
    else {
        Write-Host "[Start-Clawdbot] UI build is up-to-date, skipping" -ForegroundColor Green
    }
    
    # Check and clean port 18789
    Write-Host "[Start-Clawdbot] Checking if port 18789 is still in use..." -ForegroundColor Cyan
    $connections = netstat -ano | Select-String ":18789.*LISTENING"
    if ($connections) {
        $processId = ($connections[0] -split '\s+')[-1]
        Write-Host "[Start-Clawdbot] Port 18789 is in use by PID $processId. Killing it..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    
    # Start Gateway in new window
    Write-Host "[Start-Clawdbot] Starting Clawdbot Gateway..." -ForegroundColor Green
    Write-Host "[Start-Clawdbot] Opening a new window for gateway logs..." -ForegroundColor Gray
    
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "cd '$RepoDir'; node dist/entry.js gateway run --bind loopback --port 18789 --allow-unconfigured"
    )
    
    Write-Host "[Start-Clawdbot] Gateway started in new window!" -ForegroundColor Green
    Write-Host "[Start-Clawdbot] Opening Control UI with token..." -ForegroundColor Gray
    
    # Wait for Gateway to start
    Start-Sleep -Seconds 2
    
    # Open tokenized Dashboard
    $token = "07f14e7c946cd9b4cd521eca7dc602e8560dcfbeb92c0013"
    Start-Process "http://127.0.0.1:18789/?token=$token"
    
    Write-Host "[Start-Clawdbot] Control UI opened with authentication!" -ForegroundColor Green
    Write-Host "[Start-Clawdbot] This window will close in 3 seconds..." -ForegroundColor Gray
    Start-Sleep -Seconds 3
}
finally {
    Pop-Location
}
