$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/service-process.ps1')
$listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
try {
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $owners = @(Get-XhsPortListeners $port)
    if (@($owners.OwningProcess) -notcontains $PID) { throw 'Listener owner was not detected.' }
    $listener.Stop()
    if (@(Get-XhsPortListeners $port).Count -ne 0) { throw 'Closed listener was still detected.' }
} finally { $listener.Stop() }
$timer = [Diagnostics.Stopwatch]::StartNew()
$timedOut = $false
try {
    $shell = Join-Path $PSHOME 'powershell.exe'
    if (-not (Test-Path -LiteralPath $shell)) { $shell = Join-Path $PSHOME 'pwsh.exe' }
    $null = Invoke-XhsBoundedProcess $shell '-NoProfile -Command "Start-Sleep -Seconds 20"' 1000
} catch {
    if ($_.Exception.Message -notmatch 'timed out') { throw }
    $timedOut = $true
}
$timer.Stop()
if (-not $timedOut -or $timer.ElapsedMilliseconds -gt 5000) { throw 'Process timeout did not stop the query promptly.' }
'PASS: listener owner, closed port, and bounded process timeout.'
