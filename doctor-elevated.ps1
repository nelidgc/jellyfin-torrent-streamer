[CmdletBinding()]
param(
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $projectRoot "config.json" }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$logDirectory = Join-Path $projectRoot "data\logs"
$logPath = Join-Path $logDirectory "doctor-elevated.txt"
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Push-Location $projectRoot
try {
    & $nodeExe ".\torrent-jellyfin.mjs" doctor --config $ConfigPath *>&1 |
        Tee-Object -FilePath $logPath
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
