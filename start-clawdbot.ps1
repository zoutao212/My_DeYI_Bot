# Clawdbot 快速启动脚本
$ErrorActionPreference = "Stop"
$RepoDir = "E:\myclawdbot"
$env:CLAWDBOT_CLAUDE_SKIP_PERMISSIONS = "1"

Write-Host "[Start-Clawdbot] Repo: $RepoDir" -ForegroundColor Cyan

# 检查仓库目录
if (-not (Test-Path "$RepoDir\package.json")) {
    Write-Host "[Start-Clawdbot] ERROR: repo not found at $RepoDir" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# 切换到仓库目录
Push-Location $RepoDir

try {
    # 检查并清理端口 18789
    Write-Host "[Start-Clawdbot] Checking if port 18789 is still in use..." -ForegroundColor Cyan
    $connections = netstat -ano | Select-String ":18789.*LISTENING"
    if ($connections) {
        $processId = ($connections[0] -split '\s+')[-1]
        Write-Host "[Start-Clawdbot] Port 18789 is in use by PID $processId. Killing it..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    
    # 启动 Gateway（新窗口）
    Write-Host "[Start-Clawdbot] Starting Clawdbot Gateway..." -ForegroundColor Green
    Write-Host "[Start-Clawdbot] Opening a new window for gateway logs..." -ForegroundColor Gray
    
    # 启动新窗口运行gateway
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "cd '$RepoDir'; node dist/entry.js gateway run --bind loopback --port 18789 --allow-unconfigured"
    )
    
    Write-Host "[Start-Clawdbot] Gateway started in new window!" -ForegroundColor Green
    Write-Host "[Start-Clawdbot] This window will close in 3 seconds..." -ForegroundColor Gray
    Start-Sleep -Seconds 3
}
finally {
    Pop-Location
}
