# Clawdbot 快速启动脚本（带智能构建检测）
# 版本：v20260204_1

$ErrorActionPreference = "Stop"
$RepoDir = "D:\Git_GitHub\clawdbot"
$env:CLAWDBOT_CLAUDE_SKIP_PERMISSIONS = "1"

Write-Host "[Start-Clawdbot] Repo: $RepoDir" -ForegroundColor Cyan

# 检查仓库目录
if (-not (Test-Path "$RepoDir\package.json")) {
    Write-Host "[Start-Clawdbot] ERROR: repo not found at $RepoDir" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# 检查 pnpm
$pnpmPath = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmPath) {
    Write-Host "[Start-Clawdbot] ERROR: pnpm not found" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[Start-Clawdbot] pnpm: $($pnpmPath.Source)" -ForegroundColor Gray

# 切换到仓库目录
Push-Location $RepoDir

try {
    # 停止现有的 Gateway（跳过 - 可能会卡住）
    Write-Host "[Start-Clawdbot] Skipping gateway stop (use Task Manager if needed)..." -ForegroundColor Yellow
    # & pnpm run clawdbot gateway stop 2>&1 | Out-Null
    
    # 智能构建检测
    Write-Host "[Start-Clawdbot] Checking if build is needed..." -ForegroundColor Cyan
    
    $needBuild = $false
    $distEntry = Join-Path $RepoDir "dist\entry.js"
    $buildStamp = Join-Path $RepoDir "dist\.buildstamp"
    
    # 检查 dist 和 .buildstamp 是否存在
    if (-not (Test-Path $distEntry)) {
        Write-Host "[Start-Clawdbot] Build needed: dist\entry.js not found" -ForegroundColor Yellow
        $needBuild = $true
    }
    elseif (-not (Test-Path $buildStamp)) {
        Write-Host "[Start-Clawdbot] Build needed: .buildstamp not found" -ForegroundColor Yellow
        $needBuild = $true
    }
    else {
        # 获取 .buildstamp 的时间戳
        $stampTime = (Get-Item $buildStamp).LastWriteTime
        
        # 检查 src 目录中的文件（排除测试文件）
        $srcFiles = Get-ChildItem -Path "$RepoDir\src" -Recurse -File |
            Where-Object { $_.Name -notmatch '\.test\.tsx?$' -and $_.Name -ne 'test-helpers.ts' }
        
        $newestSrc = $srcFiles | Measure-Object -Property LastWriteTime -Maximum | Select-Object -ExpandProperty Maximum
        
        if ($newestSrc -gt $stampTime) {
            Write-Host "[Start-Clawdbot] Build needed: source files are newer than build" -ForegroundColor Yellow
            $needBuild = $true
        }
        else {
            # 检查配置文件
            $tsconfig = Get-Item "$RepoDir\tsconfig.json"
            $packageJson = Get-Item "$RepoDir\package.json"
            
            if ($tsconfig.LastWriteTime -gt $stampTime -or $packageJson.LastWriteTime -gt $stampTime) {
                Write-Host "[Start-Clawdbot] Build needed: config files are newer than build" -ForegroundColor Yellow
                $needBuild = $true
            }
        }
    }
    
    # 执行构建（如果需要）
    if ($needBuild) {
        Write-Host "[Start-Clawdbot] Building TypeScript..." -ForegroundColor Yellow
        & pnpm build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[Start-Clawdbot] ERROR: Build failed" -ForegroundColor Red
            Read-Host "Press Enter to exit"
            exit 1
        }
        Write-Host "[Start-Clawdbot] Build completed successfully" -ForegroundColor Green
    }
    else {
        Write-Host "[Start-Clawdbot] Build is up-to-date, skipping build step" -ForegroundColor Green
    }
    
    # 检查并清理端口 18789
    Write-Host "[Start-Clawdbot] Checking if port 18789 is still in use..." -ForegroundColor Cyan
    $connections = netstat -ano | Select-String ":18789.*LISTENING"
    if ($connections) {
        $pid = ($connections[0] -split '\s+')[-1]
        Write-Host "[Start-Clawdbot] Port 18789 is in use by PID $pid. Killing it..." -ForegroundColor Yellow
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    
    # 启动 Gateway（新窗口）
    Write-Host "[Start-Clawdbot] Starting Clawdbot Gateway..." -ForegroundColor Green
    Write-Host "[Start-Clawdbot] Opening a new window for gateway logs..." -ForegroundColor Gray
    
    Start-Process powershell -ArgumentList @(
        "-NoExit",
        "-Command",
        "cd '$RepoDir'; pnpm run clawdbot gateway run --bind loopback --port 18789 --force"
    )
    
    # 等待 Gateway 健康检查
    Write-Host "[Start-Clawdbot] Waiting for gateway health..." -ForegroundColor Cyan
    $healthy = $false
    for ($i = 1; $i -le 15; $i++) {
        Start-Sleep -Seconds 1
        & pnpm run clawdbot gateway health --bind loopback --port 18789 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            $healthy = $true
            break
        }
    }
    
    if ($healthy) {
        Write-Host "[Start-Clawdbot] Gateway is healthy!" -ForegroundColor Green
        Write-Host "[Start-Clawdbot] This window will close in 10 seconds..." -ForegroundColor Gray
        Start-Sleep -Seconds 10
    }
    else {
        Write-Host "[Start-Clawdbot] ERROR: Gateway did not become healthy" -ForegroundColor Red
        Write-Host "[Start-Clawdbot] Check the Gateway window for errors" -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
    }
}
finally {
    Pop-Location
}
