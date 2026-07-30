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

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    try {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $TaskName
        Write-Host "Restarted scheduled task: $TaskName"
        exit 0
    }
    catch {
        throw "Could not restart the SYSTEM task. Open PowerShell as Administrator and try again. $($_.Exception.Message)"
    }
}

$configDirectory = Split-Path -Parent $ConfigPath
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$torrServerPath = if ([IO.Path]::IsPathRooted($config.torrServer.executable)) {
    [IO.Path]::GetFullPath($config.torrServer.executable)
}
else {
    [IO.Path]::GetFullPath((Join-Path $configDirectory $config.torrServer.executable))
}

foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
    if ($process.CommandLine -and $process.CommandLine.IndexOf($scriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Milliseconds 800

foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'TorrServer.exe'" -ErrorAction SilentlyContinue)) {
    if ($process.ExecutablePath -and ([IO.Path]::GetFullPath($process.ExecutablePath) -ieq $torrServerPath)) {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Milliseconds 800

$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$arguments = ('"{0}" run --config "{1}"' -f $scriptPath, $ConfigPath)
$started = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList $arguments `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -PassThru

Write-Host "Started jellyfin-torrent-streamer: node PID $($started.Id)"
