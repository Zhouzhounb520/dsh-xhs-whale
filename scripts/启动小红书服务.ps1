param([switch]$Login, [switch]$Restart, [string]$ImportCookies, [switch]$UseCompatBrowser, [switch]$Original)
$ErrorActionPreference = 'Stop'
$startupMutex = New-Object System.Threading.Mutex($false, 'Local\DSHXhsService18060')
$mutexHeld = $false
try {
try { $mutexHeld = $startupMutex.WaitOne(0) }
catch [System.Threading.AbandonedMutexException] { $mutexHeld = $true }
if (-not $mutexHeld) { throw '已有启动脚本在运行，请等待该窗口完成。' }
. (Join-Path $PSScriptRoot 'service-process.ps1')
$projectRoot = Split-Path $PSScriptRoot -Parent
$vendorDir = Join-Path $projectRoot 'vendor'
$serviceData = Join-Path $projectRoot 'data\xhs-service'
$serviceExe = Join-Path $vendorDir 'xiaohongshu-mcp-windows-amd64.exe'
$officialExe = $serviceExe
$officialHash = 'cb55674f90c1649c875be9c4cde3af193b02fc34ffc860c40c8d711e6ca53e27'
$serviceHash = $officialHash
$checkedExe = Join-Path $vendorDir 'xiaohongshu-mcp-checked.exe'
$checkedManifest = Join-Path $vendorDir 'checked-build.json'
if (-not $Original -and -not (Test-Path -LiteralPath $checkedExe)) {
    throw '缺少评论修复版，请先运行 scripts\构建评论修复版.ps1；原版不支持真实 @，如需原版请显式加 -Original。'
}
if (-not $Original -and (Test-Path -LiteralPath $checkedExe)) {
    if (-not (Test-Path -LiteralPath $checkedManifest)) { throw '修复版缺少构建校验信息，请先运行 构建评论修复版.ps1。' }
    $build = Get-Content -LiteralPath $checkedManifest -Raw | ConvertFrom-Json
    if ($build.sha256 -notmatch '^[a-f0-9]{64}$') { throw '修复版校验信息无效。' }
    $serviceExe = $checkedExe
    $serviceHash = $build.sha256
    Write-Output '使用评论修复版（支持真实提及和分阶段核验）。'
}
$loginExe = Join-Path $vendorDir 'xiaohongshu-login-windows-amd64.exe'
$cookieFile = Join-Path $serviceData 'cookies.json'
$pidFile = Join-Path $serviceData 'service.pid'
$serviceUrl = 'http://127.0.0.1:18060'
New-Item -ItemType Directory -Path $serviceData -Force | Out-Null
function Assert-Binary([string]$Path, [string]$Hash) {
    if (-not (Test-Path -LiteralPath $Path)) { throw '请先运行 scripts\安装小红书服务.ps1。' }
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
    if ($actual -ne $Hash) { throw '程序校验失败，请重新运行安装脚本。' }
}
function Get-CookieCount([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    try {
        $raw = Get-Content -LiteralPath $Path -Raw
        $document = $raw | ConvertFrom-Json
        $items = if ($raw.TrimStart().StartsWith('[')) { $document } else { $document.cookies }
        return @($items | Where-Object { $_ -and $_.name -and $_.domain -and $_.value }).Count
    } catch { throw '登录文件不是有效的 Cookie JSON；文件内容不会输出到日志。' }
}
Assert-Binary $serviceExe $serviceHash
if ($Login) { Assert-Binary $loginExe 'edc313583d681701095e57688069a263ea06fa83f2e6a82c2d8578f8ba1224cd' }
$importPath = $null
if ($ImportCookies) {
    $importPath = (Resolve-Path -LiteralPath $ImportCookies).Path
    if ((Get-CookieCount $importPath) -eq 0) { throw '指定文件没有可用 Cookie，请先完成登录。' }
}
# Only stop this project's recorded process after verifying its executable.
$ownedProcess = $null
if (Test-Path -LiteralPath $pidFile) {
    $recordedPid = 0
    if ([int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$recordedPid)) {
        $candidate = Get-Process -Id $recordedPid -ErrorAction SilentlyContinue
        if ($candidate -and @($officialExe, $checkedExe) -contains $candidate.Path) {
            $expectedHash = if ($candidate.Path -eq $checkedExe) { (Get-Content -LiteralPath $checkedManifest -Raw | ConvertFrom-Json).sha256 } else { $officialHash }
            Assert-Binary $candidate.Path $expectedHash
            $ownedProcess = $candidate
        }
    }
}
Write-Output '正在检查 18060 端口（最长 5 秒）…'
$listener = @(Get-XhsPortListeners)
if ($listener -and $ownedProcess -and @($listener.OwningProcess) -notcontains $ownedProcess.Id) {
    throw '18060 端口被其他进程占用。未停止本项目服务或其他进程。'
}
if ($listener -and -not $ownedProcess) {
    $listenerIds = @($listener.OwningProcess | Select-Object -Unique)
    if ($listenerIds.Count -eq 1) {
        $candidate = Get-Process -Id $listenerIds[0] -ErrorAction Stop
        # Recover a stale PID file only for the exact selected, hash-verified binary.
        if ($candidate.Path -eq $serviceExe) {
            Assert-Binary $candidate.Path $serviceHash
            $ownedProcess = $candidate
            Set-Content -LiteralPath $pidFile -Value $candidate.Id
        }
    }
}
if ($ownedProcess -and ($Login -or $Restart -or $importPath -or $ownedProcess.Path -ne $serviceExe)) {
    if ($ownedProcess.Path -ne $serviceExe) { Write-Output '当前运行版本与所选版本不同，正在切换到所选服务。' }
    Write-Output '正在停止本项目旧服务…'
    Stop-Process -Id $ownedProcess.Id
    if (-not $ownedProcess.WaitForExit(10000)) { throw '旧服务未能在 10 秒内退出，请关闭旧服务后重试。' }
    $listener = @(Get-XhsPortListeners)
    $ownedProcess = $null
}
if ($listener -and $Restart -and -not $ownedProcess) {
    # A manually launched copy in this project can be adopted only on explicit restart,
    # after checking both its full path and the pinned official release hash.
    $allowedExecutables = @($officialExe, $checkedExe, (Join-Path $projectRoot 'xiaohongshu-mcp-windows-amd64.exe'))
    $listenerIds = @($listener.OwningProcess | Select-Object -Unique)
    if ($listenerIds.Count -ne 1) { throw '端口存在多个进程，无法安全接管。' }
    $manualProcess = Get-Process -Id $listenerIds[0] -ErrorAction Stop
    if ($allowedExecutables -notcontains $manualProcess.Path) { throw '端口属于其他程序，未停止该进程。' }
    $expectedHash = if ($manualProcess.Path -eq $checkedExe) { (Get-Content -LiteralPath $checkedManifest -Raw | ConvertFrom-Json).sha256 } else { $officialHash }
    Assert-Binary $manualProcess.Path $expectedHash
    Stop-Process -Id $manualProcess.Id
    if (-not $manualProcess.WaitForExit(10000)) { throw '旧服务未能在 10 秒内退出，请关闭旧服务后重试。' }
    $listener = @(Get-XhsPortListeners)
    Write-Output '已停止本项目中手动启动的同版本服务，将由脚本重新启动。'
}
if ($listener -and (-not $ownedProcess -or @($listener.OwningProcess) -notcontains $ownedProcess.Id)) {
    throw '18060 端口被其他进程占用。未修改登录文件或停止该进程。'
}
function Assert-ServiceCapabilities {
    if ($Original) { Write-Warning '当前选择原版服务，不支持真实 @ 主人。'; return }
    try { $capabilities = Invoke-RestMethod -Uri "$serviceUrl/api/v1/capabilities" -TimeoutSec 5 }
    catch { throw '当前服务未提供真实 @ 接口，请运行本项目根目录的「启动小红书服务.cmd -Restart」重新启动。' }
    if (-not $capabilities.success -or $capabilities.data.checked_comments -ne 1 -or $capabilities.data.real_mentions -ne 1) {
        throw '当前服务未通过真实 @ 能力检查，请重新构建评论修复版后启动。'
    }
    Write-Output '真实 @ 主人接口检查通过。'
}
if ($ownedProcess) { Assert-ServiceCapabilities; Write-Output "本项目服务已运行：$serviceUrl；重启可加 -Restart。"; return }
if ($importPath -and $importPath -ne [IO.Path]::GetFullPath($cookieFile)) {
    if (Test-Path -LiteralPath $cookieFile) { Copy-Item -LiteralPath $cookieFile -Destination "$cookieFile.backup-$(Get-Date -Format yyyyMMdd-HHmmss-fff)" }
    Copy-Item -LiteralPath $importPath -Destination $cookieFile -Force
    Write-Output '已导入登录状态并备份原文件；未输出 Cookie 内容。'
}
if (-not $Login -and (Get-CookieCount $cookieFile) -eq 0) { Write-Warning '没有登录数据，可加 -Login 扫码，或用 -ImportCookies 指定已登录的 cookies.json。' }
$savedLocalAppData = $env:LOCALAPPDATA
$savedCookiesPath = $env:COOKIES_PATH
try {
    # Login and service always share one explicit session file, never a temp-directory fallback.
    $env:COOKIES_PATH = [IO.Path]::GetFullPath($cookieFile)
    $compatFile = Join-Path $serviceData 'browser-compat.json'
    if ($UseCompatBrowser) {
        if (-not (Test-Path -LiteralPath $compatFile)) { throw '请先运行 scripts/准备兼容浏览器.ps1。' }
        $compat = Get-Content -LiteralPath $compatFile -Raw | ConvertFrom-Json
        $runtimePath = [IO.Path]::GetFullPath($compat.runtime)
        $vendorPrefix = [IO.Path]::GetFullPath($vendorDir) + [IO.Path]::DirectorySeparatorChar
        if (-not $runtimePath.StartsWith($vendorPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw '兼容浏览器路径必须位于本项目 vendor 目录。' }
        if (-not (Test-Path -LiteralPath (Join-Path $runtimePath 'xiaohongshu-mcp\browser\148.0.7778.215\browser\chrome.exe'))) { throw '兼容浏览器缺失，请重新运行准备兼容浏览器.ps1。' }
        $env:LOCALAPPDATA = $runtimePath
        Write-Output "使用独立 Chrome 兼容浏览器：$($compat.version)"
    } else {
        Write-Output '使用上游默认浏览器（与直接运行登录程序一致）。'
    }
    if ($Login) {
        Write-Output '请在弹出的浏览器中登录。登录后自动关窗属于正常行为，随后将启动服务。'
        $loginProcess = Start-Process -FilePath $loginExe -WorkingDirectory $serviceData -Wait -PassThru
        if ($loginProcess.ExitCode -ne 0) { throw "登录程序退出异常（$($loginProcess.ExitCode)），未启动服务。" }
        if ((Get-CookieCount $cookieFile) -eq 0) { throw '未保存登录数据，请重新运行并完成登录。' }
    }
    Write-Output '正在启动小红书后台服务…'
    $process = Start-Process -FilePath $serviceExe -ArgumentList '-port', '127.0.0.1:18060' -WorkingDirectory $serviceData -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $serviceData 'stdout.log') -RedirectStandardError (Join-Path $serviceData 'stderr.log')
    Set-Content -LiteralPath $pidFile -Value $process.Id
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ($process.HasExited) { throw '服务启动失败，请查看 data/xhs-service/stderr.log。' }
        try {
            $health = Invoke-RestMethod -Uri "$serviceUrl/health" -TimeoutSec 1
            if ($health.success -eq $true) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    if (-not $ready) { Write-Warning '进程已启动但 HTTP 接口尚未就绪；首次下载浏览器可能需要数分钟。'; return }
    Write-Output "小红书 HTTP 服务已就绪：$serviceUrl"
    Assert-ServiceCapabilities
    Write-Output '正在检查登录状态（最长 35 秒）…'
    try {
        $status = Invoke-RestMethod -Uri "$serviceUrl/api/v1/login/status" -TimeoutSec 35
        if ($status.success -and $status.data.is_logged_in) {
            Write-Output '登录状态有效。请打开 http://127.0.0.1:18061 使用阅读助手。'
        } else { Write-Warning '服务已运行，但登录未生效，请加 -Login 重新登录。' }
    } catch { Write-Warning '服务已运行，但未能核验登录。请在工作台检查登录或查看 data/xhs-service/stderr.log；不代表已登录。' }
} finally {
    $env:LOCALAPPDATA = $savedLocalAppData
    $env:COOKIES_PATH = $savedCookiesPath
}
} finally {
    if ($mutexHeld) { $startupMutex.ReleaseMutex() }
    $startupMutex.Dispose()
}
