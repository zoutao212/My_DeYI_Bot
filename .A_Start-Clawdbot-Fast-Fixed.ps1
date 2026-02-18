# Clawdbot Quick Start Script
$ErrorActionPreference = "Stop"
$RepoDir = "E:\myclawdbot"
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
    # 智能构建检测
    Write-Host "[Start-Clawdbot] Checking if build is needed..." -ForegroundColor Cyan
    
    $needBuild = $false
    $needUiBuild = $false
    $distEntry = Join-Path $RepoDir "dist\entry.js"
    $buildStamp = Join-Path $RepoDir "dist\.buildstamp"
    $controlUiIndex = Join-Path $RepoDir "dist\control-ui\index.html"
    
    # 检查 TypeScript 构建
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
    
    # 检查 UI 构建
    if (-not (Test-Path $controlUiIndex)) {
        Write-Host "[Start-Clawdbot] UI Build needed: control-ui\index.html not found" -ForegroundColor Yellow
        $needUiBuild = $true
    }
    else {
        # 检查 ui 目录中的文件是否比构建的UI新
        if (Test-Path "$RepoDir\ui" -PathType Container) {
            try {
                $uiSrcFiles = Get-ChildItem -Path "$RepoDir\ui" -Recurse -File -ErrorAction Stop
                if ($uiSrcFiles) {
                    $newestUiSrc = $uiSrcFiles | Measure-Object -Property LastWriteTime -Maximum | Select-Object -ExpandProperty Maximum
                    $builtUiTime = (Get-Item $controlUiIndex).LastWriteTime
                    
                    if ($newestUiSrc -gt $builtUiTime) {
                        Write-Host "[Start-Clawdbot] UI Build needed: UI source files are newer than build" -ForegroundColor Yellow
                        $needUiBuild = $true
                    }
                }
            }
            catch {
                # UI检查失败，跳过UI构建检查
                Write-Host "[Start-Clawdbot] UI source check failed, skipping" -ForegroundColor Yellow
            }
        }
    }
    
    # 执行 TypeScript 构建（如果需要）
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
    
    # 执行 UI 构建（如果需要）
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
    
    # 等待2秒让Gateway完全启动
    Start-Sleep -Seconds 2
    
    # 打开带token的Dashboard
    $token = "07f14e7c946cd9b4cd521eca7dc602e8560dcfbeb92c0013"
    Start-Process "http://127.0.0.1:18789/?token=$token"
    
    Write-Host "[Start-Clawdbot] Control UI opened with authentication!" -ForegroundColor Green
    Write-Host "[Start-Clawdbot] This window will close in 3 seconds..." -ForegroundColor Gray
    Start-Sleep -Seconds 3
}
finally {
    Pop-Location
}
