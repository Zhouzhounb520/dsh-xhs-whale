param([string]$GoExe = '', [string]$GoProxy = '', [string]$OutputDir = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$source = Join-Path $projectRoot 'upstream/xiaohongshu-mcp'
if (-not $GoExe) {
    $command = Get-Command go -ErrorAction SilentlyContinue
    if ($command) { $GoExe = $command.Source }
    else { $GoExe = Join-Path $projectRoot 'vendor/go-runtime/go/bin/go.exe' }
}
if (-not (Test-Path -LiteralPath $GoExe)) { throw '请安装 Go 1.24 或更新版本并加入 PATH，或通过 -GoExe 指定 go.exe。' }
if (-not (Test-Path -LiteralPath (Join-Path $source 'go.mod'))) { throw '缺少 upstream/xiaohongshu-mcp 源码，请使用完整源码包。' }
if (-not $OutputDir) { $OutputDir = Join-Path $projectRoot 'vendor' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$savedCache=$env:GOCACHE; $savedMod=$env:GOMODCACHE; $savedProxy=$env:GOPROXY
try {
    if (-not $env:GOCACHE) { $env:GOCACHE=Join-Path $projectRoot 'vendor/go-cache' }
    if (-not $env:GOMODCACHE) { $env:GOMODCACHE=Join-Path $projectRoot 'vendor/go-mod' }
    if ($GoProxy) { $env:GOPROXY=$GoProxy }
    & $GoExe -C $source test . ./xiaohongshu -run '^TestChecked' -count=1
    if ($LASTEXITCODE -ne 0) { throw '评论修复版测试失败，未替换程序。' }
    $next=Join-Path $OutputDir 'xiaohongshu-mcp-checked-next.exe'
    & $GoExe -C $source build -trimpath -ldflags '-X main.version=v2.5.5-checked-local' -o $next .
    if ($LASTEXITCODE -ne 0) { throw '编译失败，未替换程序。' }
    $target=Join-Path $OutputDir 'xiaohongshu-mcp-checked.exe'
    Move-Item -LiteralPath $next -Destination $target -Force
    $stream=[IO.File]::OpenRead($target); $sha=[Security.Cryptography.SHA256]::Create()
    try { $hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
    $manifest=@{ upstream='v2.5.5'; sha256=$hash; builtAt=(Get-Date).ToUniversalTime().ToString('o') }
    $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir 'checked-build.json') -Encoding utf8
    Write-Output "修复版构建完成：$target"
} finally {
    $env:GOCACHE=$savedCache; $env:GOMODCACHE=$savedMod; $env:GOPROXY=$savedProxy
}
