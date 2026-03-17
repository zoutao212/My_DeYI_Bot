# Clawdbot Quick Start Script - Version 2
$ErrorActionPreference = "Stop"
$RepoDir = "D:\Git_GitHub\clawdbot"
$env:CLAWDBOT_CLAUDE_SKIP_PERMISSIONS = "1"

$env:CLAWDBOT_PROACTIVE_RETRIEVAL_ENABLED = "1"

$env:CLAWDBOT_DEBUG_AGENT_EVENTS = "1"
$env:CLAWDBOT_TEXTETL_AUTOGEN_ENABLED="1"
$env:CLAWDBOT_TEXTETL_AUTOGEN_MIN_RESULTS="4"

$env:CLAWDBOT_TEXTETL_TARGET_CHUNK_CHARS="3000"
$env:CLAWDBOT_TEXTETL_MAX_CHAPTER_CHARS="6000"
$env:CLAWDBOT_TEXTETL_MICRO_CHUNK_CHARS="300"
$env:CLAWDBOT_TEXTETL_ENABLE_MICRO_CHUNKS="true"
$env:CLAWDBOT_TEXTETL_MEMORY_ENABLED="1"
$env:CLAWDBOT_TEXTETL_MEMORY_FTS_ONLY="1"

# 可选：显式指定目录
$env:CLAWDBOT_NOVELS_ASSETS_DIR="C:\Users\zouta\clawd\NovelsAssets"
$env:CLAWDBOT_NOVELS_CHUNK_ASSETS_DIR="C:\Users\zouta\clawd\NovelsChunkAssets"

Write-Host "[Start-Clawdbot] Repo: $RepoDir" -ForegroundColor Cyan
Write-Host "[Start-Clawdbot] Script: $PSCommandPath" -ForegroundColor DarkGray
Write-Host "[Start-Clawdbot] ScriptVersion: 2026-02-26-force-build-v3" -ForegroundColor DarkGray

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
    
    # 彻底止损：无条件重建，避免命中旧 dist 导致“代码看似改了但运行没变”
    $needBuild = $true
    $needUiBuild = $true
    $distEntry = Join-Path $RepoDir "dist\entry.js"
    $buildStamp = Join-Path $RepoDir "dist\.buildstamp"
    $controlUiIndex = Join-Path $RepoDir "dist\control-ui\index.html"
    
    Write-Host "[Start-Clawdbot] Force rebuild: pnpm build + pnpm ui:build" -ForegroundColor Yellow
    
    # 后端构建：无条件执行（止损，避免跑旧 dist）
    Write-Host "[Start-Clawdbot] Building TypeScript (forced)..." -ForegroundColor Yellow
    & pnpm build
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[Start-Clawdbot] ERROR: TypeScript build failed" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "[Start-Clawdbot] TypeScript build completed successfully" -ForegroundColor Green
    
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
catch {
    Write-Host "[Start-Clawdbot] ERROR: $_" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
finally {
    Pop-Location
}
