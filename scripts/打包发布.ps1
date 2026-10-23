param([string]$NodeExe = 'node')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$result = & $NodeExe (Join-Path $projectRoot 'tools/package-release.mjs')
if ($LASTEXITCODE -ne 0) { throw '源码检查或打包失败；没有创建 ZIP。' }
$source = [IO.Path]::GetFullPath([string]($result | Select-Object -Last 1))
$allowed = [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist')) + [IO.Path]::DirectorySeparatorChar
if (-not $source.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw '输出路径不属于 dist。' }
$zip = $source + '.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
# .NET includes dotfiles such as .github and .gitignore, unlike some archive tools.
[IO.Compression.ZipFile]::CreateFromDirectory($source, $zip, [IO.Compression.CompressionLevel]::Optimal, $true)
$stream=[IO.File]::OpenRead($zip); $sha=[Security.Cryptography.SHA256]::Create()
try { $hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
finally { $stream.Dispose(); $sha.Dispose() }
[IO.File]::WriteAllText($zip + '.sha256', "$hash  $([IO.Path]::GetFileName($zip))`n", (New-Object Text.UTF8Encoding($false)))
Write-Output "Source: $source"
Write-Output "ZIP: $zip"
Write-Output "SHA256: $hash"
