param([Parameter(Mandatory=$true)][string]$DshExe)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path -LiteralPath $DshExe -PathType Leaf)) { throw '未找到 DSH，请通过 -DshExe 参数指定 DeepSeek Harness.exe。' }
$DshExe = (Resolve-Path -LiteralPath $DshExe).Path
$resourceDir = Join-Path (Split-Path $DshExe -Parent) 'resources'
$cli = Join-Path $resourceDir 'app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js'
if (-not (Test-Path -LiteralPath $DshExe)) { throw '未找到 DSH，请通过 -DshExe 参数指定 DeepSeek Harness.exe。' }
$logDir = Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$oldElectronMode = $env:ELECTRON_RUN_AS_NODE
try {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $process = Start-Process -FilePath $DshExe -ArgumentList @('--expose-internals', ('"{0}"' -f $cli), 'plugin', '--profile', 'desktop', 'add', ('"link:{0}"' -f $projectRoot)) `
        -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $logDir 'dsh-install.stdout.log') -RedirectStandardError (Join-Path $logDir 'dsh-install.stderr.log')
    if ($process.ExitCode -ne 0) { throw 'DSH 插件安装失败，请查看 data\dsh-install.stderr.log' }
} finally { $env:ELECTRON_RUN_AS_NODE = $oldElectronMode }
$profileFile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\package.json'
$profile = Get-Content -LiteralPath $profileFile -Raw | ConvertFrom-Json
if (-not $profile.dependencies.'dsh-xhs-whale') { throw '安装后未发现插件依赖，请查看安装日志。' }
# Existing desktop profiles may have an explicit bundle list.
if ($profile.dsh.profile.bundles -and $profile.dsh.profile.bundles -notcontains 'dsh-xhs-whale') {
    Copy-Item -LiteralPath $profileFile -Destination "$profileFile.xhs-backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
    $profile.dsh.profile.bundles += 'dsh-xhs-whale'
    $profile | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $profileFile -Encoding utf8
}
Write-Output '安装完成。重启 DSH 后，在设置中打开“小红书阅读”。已保留原有插件。'
