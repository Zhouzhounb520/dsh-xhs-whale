# Avoid WMI/CIM for the startup path: its network provider can block indefinitely.
function Invoke-XhsBoundedProcess([string]$FilePath, [string]$Arguments, [int]$TimeoutMs = 5000) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Unable to start process.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            $process.Kill()
            $null = $process.WaitForExit(1000)
            throw 'Port query timed out; no service process was stopped.'
        }
        if ($process.ExitCode -ne 0) { throw 'Port query failed; no service process was stopped.' }
        return $stdout.GetAwaiter().GetResult()
    } finally { $process.Dispose() }
}

function Get-XhsPortListeners([int]$Port = 18060) {
    $output = Invoke-XhsBoundedProcess (Join-Path $env:SystemRoot 'System32\netstat.exe') '-ano -p tcp'
    foreach ($line in ($output -split '\r?\n')) {
        # Match the local endpoint, including IPv6; ignore established connections.
        if ($line -match ('^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$')) {
            [pscustomobject]@{ OwningProcess = [int]$Matches[1] }
        }
    }
}
