[CmdletBinding()]
param(
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TaskName = "Jellyfin Torrent Streamer"
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$scriptPath = Join-Path $projectRoot "torrent-jellyfin.mjs"
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $projectRoot "config.json" }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Configuration not found: $ConfigPath. Run install.ps1 first."
}

$configDirectory = Split-Path -Parent $ConfigPath
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$torrServerPath = if ([IO.Path]::IsPathRooted($config.torrServer.executable)) {
    [IO.Path]::GetFullPath($config.torrServer.executable)
}
else {
    [IO.Path]::GetFullPath((Join-Path $configDirectory $config.torrServer.executable))
}

function Stop-ManagedProcesses {
    $nodeIds = [Collections.Generic.HashSet[int]]::new()
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
        if ($process.CommandLine -and $process.CommandLine.IndexOf($scriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            [void]$nodeIds.Add([int]$process.ProcessId)
        }
    }

    foreach ($listener in @(Get-NetTCPConnection -State Listen -LocalPort ([int]$config.gateway.port) -ErrorAction SilentlyContinue)) {
        $owner = Get-Process -Id ([int]$listener.OwningProcess) -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -ieq "node") {
            [void]$nodeIds.Add([int]$listener.OwningProcess)
        }
    }

    foreach ($processId in $nodeIds) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Milliseconds 800

    $torrServerIds = [Collections.Generic.HashSet[int]]::new()
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'TorrServer.exe'" -ErrorAction SilentlyContinue)) {
        if ($process.ExecutablePath -and ([IO.Path]::GetFullPath($process.ExecutablePath) -ieq $torrServerPath)) {
            [void]$torrServerIds.Add([int]$process.ProcessId)
        }
    }

    foreach ($listener in @(Get-NetTCPConnection -State Listen -LocalPort ([int]$config.torrServer.port) -ErrorAction SilentlyContinue)) {
        $owner = Get-Process -Id ([int]$listener.OwningProcess) -ErrorAction SilentlyContinue
        if ($owner -and $owner.ProcessName -ieq "TorrServer") {
            [void]$torrServerIds.Add([int]$listener.OwningProcess)
        }
    }

    foreach ($processId in $torrServerIds) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Milliseconds 800
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    try {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Stop-ManagedProcesses
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "Restarted scheduled task: $TaskName"
        exit 0
    }
    catch {
        throw "Could not restart the SYSTEM task. Open PowerShell as Administrator and try again. $($_.Exception.Message)"
    }
}

Stop-ManagedProcesses

$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$arguments = ('"{0}" run --config "{1}"' -f $scriptPath, $ConfigPath)
$started = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru

Write-Host "Started jellyfin-torrent-streamer: node PID $($started.Id)"
