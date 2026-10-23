$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$chromeRoot = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application')
) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'chrome.exe') } | Select-Object -First 1
if (-not $chromeRoot) { throw '未找到已安装的 Google Chrome，请先安装 Chrome。' }
$chromeExe = Join-Path $chromeRoot 'chrome.exe'
$signature = Get-AuthenticodeSignature -FilePath $chromeExe
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Google LLC') {
    throw 'Chrome 的 Google 数字签名验证失败。'
}
$version = (Get-Item -LiteralPath $chromeExe).VersionInfo.ProductVersion
if ($version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw '无法识别 Chrome 版本。' }
$versionSource = Join-Path $chromeRoot $version
if (-not (Test-Path -LiteralPath $versionSource)) { throw 'Chrome 安装不完整，请完成更新后再试。' }
# The upstream release has a fixed cache lookup. Isolate it in this project and
# copy only application binaries; never use the person's Chrome user profile.
$runtime = Join-Path $projectRoot "vendor\chrome-compat-$version"
$target = Join-Path $runtime 'xiaohongshu-mcp\browser\148.0.7778.215\browser'
New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item -LiteralPath $versionSource -Destination $target -Recurse -Force
Copy-Item -LiteralPath $chromeExe -Destination (Join-Path $target 'chrome.exe') -Force
if ((Get-FileHash -LiteralPath $chromeExe).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target 'chrome.exe')).Hash) {
    throw 'Chrome 副本校验失败。'
}
$serviceData = Join-Path $projectRoot 'data\xhs-service'
New-Item -ItemType Directory -Path $serviceData -Force | Out-Null
@{ version = $version; runtime = $runtime; source = $chromeRoot } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $serviceData 'browser-compat.json') -Encoding utf8
Write-Output "已准备 Chrome $version 的独立副本。重新启动小红书服务后生效。"
