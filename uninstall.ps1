[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
    [string]$ConfigPath,
    [switch]$PurgeData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TaskName = "Jellyfin Torrent Streamer"
$FirewallRuleName = "Jellyfin Torrent Stream Gateway"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-ConfigPathValue {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$BaseDirectory
    )

    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $BaseDirectory $Value))
}

function Assert-SafeDataPath {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$ConfigDirectory,
        [Parameter(Mandatory = $true)][string]$LibraryRoot
    )

    $resolved = [IO.Path]::GetFullPath($Target).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $driveRoot = [IO.Path]::GetPathRoot($resolved).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $project = $ProjectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)
    $configDir = $ConfigDirectory.TrimEnd([IO.Path]::DirectorySeparatorChar)
    $library = $LibraryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)

    if ([string]::IsNullOrWhiteSpace($resolved) -or $resolved.Length -lt 4 -or $resolved -ieq $driveRoot) {
        throw "Refusing unsafe purge target: $Target"
    }
    if ($resolved -ieq $project -or $resolved -ieq $configDir) {
        throw "Refusing to purge the project or configuration directory: $resolved"
    }
    if ($resolved -ieq $library -or
        $library.StartsWith($resolved + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        $resolved.StartsWith($library + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to purge the media library or one of its parent directories: $resolved"
    }
    return $resolved
}

if (-not (Test-IsAdministrator)) {
    throw "Run uninstall.ps1 from an elevated PowerShell window so the startup task and Firewall rule can be removed."
}

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $projectRoot "config.json" }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$configDirectory = Split-Path -Parent $ConfigPath
$scriptPath = Join-Path $projectRoot "torrent-jellyfin.mjs"
$config = $null

if (Test-Path -LiteralPath $ConfigPath) {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue)) {
    if ($process.CommandLine -and $process.CommandLine.IndexOf($scriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        if ($PSCmdlet.ShouldProcess("node.exe PID $($process.ProcessId)", "Stop jellyfin-torrent-streamer")) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($config) {
    $executablePath = Resolve-ConfigPathValue -Value $config.torrServer.executable -BaseDirectory $configDirectory
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'TorrServer.exe'" -ErrorAction SilentlyContinue)) {
        if ($process.ExecutablePath -and ([IO.Path]::GetFullPath($process.ExecutablePath) -ieq $executablePath)) {
            if ($PSCmdlet.ShouldProcess("TorrServer.exe PID $($process.ProcessId)", "Stop the managed TorrServer process")) {
                Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $PSCmdlet.ShouldProcess($TaskName, "Remove scheduled startup task")) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$firewallRules = @(Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue)
if ($firewallRules.Count -gt 0 -and $PSCmdlet.ShouldProcess($FirewallRuleName, "Remove Firewall rule")) {
    $firewallRules | Remove-NetFirewallRule
}

if ($PurgeData) {
    if (-not $config) {
        throw "Cannot safely purge data because the configuration file is missing: $ConfigPath"
    }

    $libraryRoot = Resolve-ConfigPathValue -Value $config.paths.library -BaseDirectory $configDirectory
    $targets = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in @("inbox", "processed", "failed", "state", "cache", "logs")) {
        $candidate = Resolve-ConfigPathValue -Value $config.paths.$property -BaseDirectory $configDirectory
        $safeTarget = Assert-SafeDataPath `
            -Target $candidate `
            -ProjectRoot $projectRoot `
            -ConfigDirectory $configDirectory `
            -LibraryRoot $libraryRoot
        [void]$targets.Add($safeTarget)
    }

    foreach ($target in $targets) {
        if ((Test-Path -LiteralPath $target) -and $PSCmdlet.ShouldProcess($target, "Permanently remove application data")) {
            Remove-Item -LiteralPath $target -Recurse -Force
            Write-Host "Removed: $target"
        }
    }
}

Write-Host "Uninstall complete."
Write-Host "Preserved configuration: $ConfigPath"
if (-not $PurgeData) {
    Write-Host "Preserved torrent archive, state, cache and logs. Use -PurgeData only when permanent data deletion is intended."
}
Write-Host "TorrServer.exe and the project files were not deleted."
