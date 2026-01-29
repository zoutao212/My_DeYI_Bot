# 文本文件编码检测和转换工具
# 用途：检测文本文件的编码，并转换为 UTF-8

param(
    [Parameter(Mandatory=$true, HelpMessage="要处理的文件路径")]
    [string]$FilePath,
    
    [Parameter(HelpMessage="目标编码，默认 UTF-8")]
    [string]$TargetEncoding = "UTF-8",
    
    [Parameter(HelpMessage="是否覆盖原文件")]
    [switch]$Overwrite,
    
    [Parameter(HelpMessage="是否添加 BOM")]
    [switch]$WithBOM
)

# 检查文件是否存在
if (-not (Test-Path $FilePath)) {
    Write-Host "❌ 文件不存在: $FilePath" -ForegroundColor Red
    exit 1
}

# 获取文件信息
$fileInfo = Get-Item $FilePath
Write-Host "📄 文件: $($fileInfo.Name)" -ForegroundColor Cyan
Write-Host "📏 大小: $([Math]::Round($fileInfo.Length / 1KB, 2)) KB" -ForegroundColor Cyan

# 尝试检测编码
Write-Host "`n🔍 检测编码..." -ForegroundColor Yellow

$encodings = @(
    @{Name="UTF-8"; Encoding=[System.Text.Encoding]::UTF8},
    @{Name="GBK"; Encoding=[System.Text.Encoding]::GetEncoding("GBK")},
    @{Name="GB2312"; Encoding=[System.Text.Encoding]::GetEncoding("GB2312")},
    @{Name="Big5"; Encoding=[System.Text.Encoding]::GetEncoding("Big5")},
    @{Name="Shift_JIS"; Encoding=[System.Text.Encoding]::GetEncoding("Shift_JIS")}
)

$detectedEncoding = $null
$detectedEncodingName = $null

foreach ($enc in $encodings) {
    try {
        $content = [System.IO.File]::ReadAllText($FilePath, $enc.Encoding)
        
        # 检查是否有乱码字符
        $hasGarbage = $content -match '�'
        
        if (-not $hasGarbage) {
            $detectedEncoding = $enc.Encoding
            $detectedEncodingName = $enc.Name
            Write-Host "✅ 检测到编码: $($enc.Name)" -ForegroundColor Green
            
            # 显示前 200 字符
            $preview = $content.Substring(0, [Math]::Min(200, $content.Length))
            Write-Host "`n📖 内容预览:" -ForegroundColor Cyan
            Write-Host $preview
            Write-Host "..." -ForegroundColor Gray
            
            break
        }
    } catch {
        # 忽略不支持的编码
        continue
    }
}

if (-not $detectedEncoding) {
    Write-Host "❌ 无法检测编码，请手动指定" -ForegroundColor Red
    exit 1
}

# 检查是否需要转换
if ($detectedEncodingName -eq $TargetEncoding) {
    Write-Host "`n✅ 文件已是 $TargetEncoding 编码，无需转换" -ForegroundColor Green
    exit 0
}

# 转换编码
Write-Host "`n🔄 转换编码: $detectedEncodingName → $TargetEncoding" -ForegroundColor Yellow

try {
    # 读取原始内容
    $content = [System.IO.File]::ReadAllText($FilePath, $detectedEncoding)
    
    # 确定目标路径
    if ($Overwrite) {
        $targetPath = $FilePath
        Write-Host "⚠️  将覆盖原文件" -ForegroundColor Yellow
    } else {
        $targetPath = $FilePath -replace '\.([^.]+)$', "_$($TargetEncoding.ToLower()).$1"
        Write-Host "📝 目标文件: $targetPath" -ForegroundColor Cyan
    }
    
    # 创建目标编码
    if ($TargetEncoding -eq "UTF-8") {
        if ($WithBOM) {
            $targetEncodingObj = New-Object System.Text.UTF8Encoding $true
            Write-Host "📌 使用 UTF-8 with BOM" -ForegroundColor Cyan
        } else {
            $targetEncodingObj = New-Object System.Text.UTF8Encoding $false
            Write-Host "📌 使用 UTF-8 without BOM" -ForegroundColor Cyan
        }
    } else {
        $targetEncodingObj = [System.Text.Encoding]::GetEncoding($TargetEncoding)
    }
    
    # 写入文件
    [System.IO.File]::WriteAllText($targetPath, $content, $targetEncodingObj)
    
    Write-Host "`n✅ 转换完成!" -ForegroundColor Green
    Write-Host "📄 输出文件: $targetPath" -ForegroundColor Green
    
    # 验证转换结果
    $verifyContent = [System.IO.File]::ReadAllText($targetPath, $targetEncodingObj)
    $verifyPreview = $verifyContent.Substring(0, [Math]::Min(200, $verifyContent.Length))
    
    Write-Host "`n🔍 验证转换结果:" -ForegroundColor Cyan
    Write-Host $verifyPreview
    Write-Host "..." -ForegroundColor Gray
    
    # 检查是否有乱码
    if ($verifyContent -match '�') {
        Write-Host "`n⚠️  警告: 转换后仍有乱码字符，请检查" -ForegroundColor Yellow
    } else {
        Write-Host "`n✅ 验证通过，无乱码字符" -ForegroundColor Green
    }
    
} catch {
    Write-Host "`n❌ 转换失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
