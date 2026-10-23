param([switch]$SkipBuild, [string]$GoExe = '', [string]$GoProxy = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$vendorDir = Join-Path $projectRoot 'vendor'
New-Item -ItemType Directory -Path $vendorDir -Force | Out-Null
$version = 'v2.5.5'
function Get-AssetHash([string]$Path) {
    $stream=[IO.File]::OpenRead($Path); $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}
$assets = @{
    'xiaohongshu-login-windows-amd64.exe' = 'edc313583d681701095e57688069a263ea06fa83f2e6a82c2d8578f8ba1224cd'
    'xiaohongshu-mcp-windows-amd64.exe' = 'cb55674f90c1649c875be9c4cde3af193b02fc34ffc860c40c8d711e6ca53e27'
}
$oldProtocol = [Net.ServicePointManager]::SecurityProtocol
try {
    [Net.ServicePointManager]::SecurityProtocol = $oldProtocol -bor [Net.SecurityProtocolType]::Tls12
    foreach ($name in $assets.Keys) {
        $target = Join-Path $vendorDir $name
        if ((Test-Path -LiteralPath $target) -and (Get-AssetHash $target) -eq $assets[$name]) {
            Write-Output "$name 已通过校验"; continue
        }
        $partial = "$target.download"
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/xpzouying/xiaohongshu-mcp/releases/download/$version/$name" -OutFile $partial -TimeoutSec 300
        if ((Get-AssetHash $partial) -ne $assets[$name]) { throw "$name SHA256 校验失败，已停止。" }
        Move-Item -LiteralPath $partial -Destination $target -Force
        Write-Output "$name 下载并校验完成"
    }
} finally { [Net.ServicePointManager]::SecurityProtocol = $oldProtocol }
Copy-Item -LiteralPath (Join-Path $projectRoot 'upstream/xiaohongshu-mcp/LICENSE') -Destination (Join-Path $vendorDir 'LICENSE.xiaohongshu-mcp') -Force
if (-not $SkipBuild) { & (Join-Path $PSScriptRoot '构建评论修复版.ps1') -GoExe $GoExe -GoProxy $GoProxy }
else { Write-Output '已跳过构建；默认启动前仍需运行 构建评论修复版.ps1。' }
