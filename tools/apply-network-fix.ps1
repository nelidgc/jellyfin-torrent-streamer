[CmdletBinding()]
param(
    [string]$LanAddress = "192.168.0.15"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$logPath = Join-Path $projectRoot "data\logs\network-fix-admin.log"

Start-Transcript -Path $logPath -Force | Out-Null
try {
    & (Join-Path $projectRoot "install.ps1") `
        -RegisterTask `
        -ConfigureFirewall `
        -LanAddress $LanAddress

    & (Join-Path $projectRoot "restart.ps1")
    Start-Sleep -Seconds 8

    $task = Get-ScheduledTask -TaskName "Jellyfin Torrent Streamer" -ErrorAction Stop
    if ($task.State -ne "Running") {
        throw "The Jellyfin Torrent Streamer task is not running (state: $($task.State))."
    }

    foreach ($port in @(8090, 8091, 51413)) {
        $tcp = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
        $udp = if ($port -eq 51413) {
            Get-NetUDPEndpoint -LocalPort $port -ErrorAction SilentlyContinue
        }
        else {
            $null
        }
        if (-not $tcp -and -not $udp) {
            throw "Expected listener was not created on port $port."
        }
    }

    Write-Host "Network fix applied and verified."
}
finally {
    Stop-Transcript | Out-Null
}
