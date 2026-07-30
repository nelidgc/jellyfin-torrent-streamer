[CmdletBinding()]
param(
    [string]$ConfigPath,
    [string]$LibraryPath,
    [string]$CachePath,
    [Nullable[int]]$CacheSizeGB,
    [string]$LanAddress,
    [switch]$RegisterTask,
    [switch]$ConfigureFirewall,
    [switch]$RestrictBroadNodeFirewall,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$TaskName = "Jellyfin Torrent Streamer"
$FirewallRuleName = "Jellyfin Torrent Stream Gateway"
$TorrServerVersion = "MatriX.142.2"
$PinnedTorrServerSha256 = "BDC6E80DA81918A19D8A74D8FE43A6C1FC584889CB43DE66D573D735F2209A5E"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-SecureToken {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Test-UsableIPv4 {
    param([Parameter(Mandatory = $true)][string]$Address)

    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
    if ($parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    return $Address -notmatch '^(127\.|0\.|169\.254\.)'
}

function Get-PhysicalLanIPv4 {
    try {
        $configurations = @(Get-NetIPConfiguration -ErrorAction Stop |
            Where-Object { $_.NetAdapter.Status -eq "Up" -and $null -ne $_.IPv4DefaultGateway })
        $physical = @($configurations | Where-Object {
            $adapterName = "$($_.InterfaceAlias) $($_.InterfaceDescription)"
            $adapterName -notmatch '(?i)vpn|tunnel|\btun\b|\btap\b|socks|wireguard|openvpn|happ|tailscale|zerotier|hyper-v|wsl|docker'
        })
        foreach ($configuration in $physical) {
            foreach ($address in @($configuration.IPv4Address.IPAddress)) {
                if (Test-UsableIPv4 -Address $address) { return $address }
            }
        }
    }
    catch {
        Write-Verbose "Get-NetIPConfiguration failed: $($_.Exception.Message)"
    }
    return $null
}

function Resolve-ConfigPathValue {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$BaseDirectory
    )

    if ([IO.Path]::IsPathRooted($Value)) { return [IO.Path]::GetFullPath($Value) }
    return [IO.Path]::GetFullPath((Join-Path $BaseDirectory $Value))
}

function Save-JsonUtf8Atomic {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $temporaryPath = "$Path.tmp-$([Guid]::NewGuid().ToString('N'))"
    try {
        $json = $Value | ConvertTo-Json -Depth 20
        [IO.File]::WriteAllText($temporaryPath, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

if (($RegisterTask -or $ConfigureFirewall -or $RestrictBroadNodeFirewall) -and -not (Test-IsAdministrator)) {
    throw "-RegisterTask, -ConfigureFirewall and -RestrictBroadNodeFirewall require an elevated PowerShell window."
}

if ($PSBoundParameters.ContainsKey("CacheSizeGB") -and ($null -eq $CacheSizeGB -or $CacheSizeGB -lt 1 -or $CacheSizeGB -gt 2048)) {
    throw "-CacheSizeGB must be between 1 and 2048."
}
if ($PSBoundParameters.ContainsKey("LanAddress") -and -not (Test-UsableIPv4 -Address $LanAddress)) {
    throw "-LanAddress must be a non-loopback IPv4 address, for example 192.168.1.20."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "Node.js 20 or newer is required: https://nodejs.org/" }
$nodeVersionText = (& $node.Source --version).Trim().TrimStart("v")
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion.Major -lt 20) { throw "Node.js 20 or newer is required; found $nodeVersionText." }

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $projectRoot "config.json" }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$configDirectory = Split-Path -Parent $ConfigPath
New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null

$configExisted = Test-Path -LiteralPath $ConfigPath
if ($configExisted) {
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    Write-Host "Keeping existing configuration: $ConfigPath"
}
else {
    $templatePath = Join-Path $projectRoot "config.example.json"
    if (-not (Test-Path -LiteralPath $templatePath)) { throw "Missing configuration template: $templatePath" }
    $config = Get-Content -LiteralPath $templatePath -Raw | ConvertFrom-Json
}

$configChanged = -not $configExisted
if ($PSBoundParameters.ContainsKey("LibraryPath")) {
    if ([string]::IsNullOrWhiteSpace($LibraryPath)) { throw "-LibraryPath cannot be empty." }
    $config.paths.library = Resolve-ConfigPathValue -Value $LibraryPath -BaseDirectory $configDirectory
    $configChanged = $true
}
if ($PSBoundParameters.ContainsKey("CachePath")) {
    if ([string]::IsNullOrWhiteSpace($CachePath)) { throw "-CachePath cannot be empty." }
    $config.paths.cache = Resolve-ConfigPathValue -Value $CachePath -BaseDirectory $configDirectory
    $configChanged = $true
}
if ($PSBoundParameters.ContainsKey("CacheSizeGB")) {
    $config.torrServer.cacheSizeBytes = [int64]$CacheSizeGB * 1GB
    $configChanged = $true
}

$selectedLanAddress = $null
if ($PSBoundParameters.ContainsKey("LanAddress")) {
    $selectedLanAddress = $LanAddress
}
elseif (-not $configExisted) {
    $selectedLanAddress = Get-PhysicalLanIPv4
    if (-not $selectedLanAddress) {
        throw "A physical LAN IPv4 address could not be detected. Re-run with -LanAddress."
    }
}

if ($selectedLanAddress) {
    $config.gateway.bindAddress = $selectedLanAddress
    $config.gateway.publicBaseUrl = "http://${selectedLanAddress}:$($config.gateway.port)"
    if ($config.torrServer.PSObject.Properties["peerBindAddress"]) {
        $config.torrServer.peerBindAddress = "${selectedLanAddress}:0"
    }
    else {
        $config.torrServer | Add-Member -NotePropertyName peerBindAddress -NotePropertyValue "${selectedLanAddress}:0"
    }
    $configChanged = $true
}

if (-not $config.gateway.token -or $config.gateway.token -eq "CHANGE_ME") {
    $config.gateway.token = New-SecureToken
    $configChanged = $true
}

if ($configChanged) {
    Save-JsonUtf8Atomic -Value $config -Path $ConfigPath
    Write-Host "Configuration saved: $ConfigPath"
}

if ($configExisted -and -not $selectedLanAddress -and
    ($config.gateway.bindAddress -match '^(127\.0\.0\.1|localhost)$' -or $config.gateway.publicBaseUrl -match '127\.0\.0\.1|localhost')) {
    Write-Warning "The existing gateway uses loopback. Re-run with -LanAddress <physical-LAN-IP> for Jellyfin clients on the LAN."
}

foreach ($property in @("inbox", "processed", "failed", "library", "state", "cache", "logs")) {
    $directory = Resolve-ConfigPathValue -Value $config.paths.$property -BaseDirectory $configDirectory
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

$executablePath = Resolve-ConfigPathValue -Value $config.torrServer.executable -BaseDirectory $configDirectory
New-Item -ItemType Directory -Path (Split-Path -Parent $executablePath) -Force | Out-Null

$headers = @{ "User-Agent" = "Jellyfin-Torrent-Streamer-Installer" }
$releaseUrl = "https://api.github.com/repos/YouROK/TorrServer/releases/tags/$TorrServerVersion"
Write-Host "Reading TorrServer release metadata: $TorrServerVersion"
$release = Invoke-RestMethod -Uri $releaseUrl -Headers $headers
$asset = $release.assets | Where-Object { $_.name -eq "TorrServer-windows-amd64.exe" } | Select-Object -First 1
if (-not $asset) { throw "Release $TorrServerVersion does not contain TorrServer-windows-amd64.exe." }
$digestMatch = [regex]::Match([string]$asset.digest, '^sha256:([a-fA-F0-9]{64})$')
if (-not $digestMatch.Success) {
    throw "GitHub did not provide a SHA-256 digest for $($asset.name); refusing an unverified download."
}
$releaseHash = $digestMatch.Groups[1].Value.ToUpperInvariant()
if ($releaseHash -ne $PinnedTorrServerSha256) {
    throw "The official release digest differs from the installer pin. Expected $PinnedTorrServerSha256, got $releaseHash."
}
$expectedHash = $PinnedTorrServerSha256

$needDownload = $true
if (Test-Path -LiteralPath $executablePath) {
    $currentHash = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($currentHash -eq $expectedHash) {
        Write-Host "TorrServer is already installed and verified."
        $needDownload = $false
    }
    elseif (-not $Force) {
        throw "Existing TorrServer.exe has a different hash. Re-run with -Force to replace it."
    }
}

if ($needDownload) {
    $temporaryDownload = "$executablePath.download"
    try {
        Write-Host "Downloading $($asset.browser_download_url)"
        Invoke-WebRequest -Uri $asset.browser_download_url -Headers $headers -OutFile $temporaryDownload
        $downloadedHash = (Get-FileHash -LiteralPath $temporaryDownload -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($downloadedHash -ne $expectedHash) {
            throw "SHA-256 mismatch. Expected $expectedHash, got $downloadedHash."
        }
        Move-Item -LiteralPath $temporaryDownload -Destination $executablePath -Force
        Write-Host "Installed verified TorrServer: $executablePath"
    }
    finally {
        Remove-Item -LiteralPath $temporaryDownload -Force -ErrorAction SilentlyContinue
    }
}

if ($ConfigureFirewall) {
    Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule `
        -DisplayName $FirewallRuleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort ([int]$config.gateway.port) `
        -RemoteAddress LocalSubnet `
        -Profile Any | Out-Null
    Write-Host "Firewall opened TCP $($config.gateway.port) for LocalSubnet only (all Windows profiles)."
}

$broadNodeRules = @(Get-NetFirewallRule -Enabled True -Direction Inbound -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "Node.js*" })
if ($broadNodeRules.Count -gt 0) {
    if ($RestrictBroadNodeFirewall) {
        $broadNodeRules | Disable-NetFirewallRule
        Write-Host "Disabled $($broadNodeRules.Count) broad Node.js inbound Firewall rule(s)."
    }
    else {
        Write-Warning "Found $($broadNodeRules.Count) enabled broad Node.js inbound Firewall rule(s). Review them manually or re-run with -RestrictBroadNodeFirewall."
    }
}

if ($RegisterTask) {
    $scriptPath = Join-Path $projectRoot "torrent-jellyfin.mjs"
    $arguments = ('"{0}" run --config "{1}"' -f $scriptPath, $ConfigPath)
    $action = New-ScheduledTaskAction -Execute $node.Source -Argument $arguments -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $systemSid = "S-1-5-18"
    $principal = New-ScheduledTaskPrincipal -UserId $systemSid -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    $registeredTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $registeredAccount = [string]$registeredTask.Principal.UserId
    $registeredSid = if ($registeredAccount -match '^S-1-') {
        $registeredAccount
    }
    else {
        (New-Object Security.Principal.NTAccount($registeredAccount)).Translate([Security.Principal.SecurityIdentifier]).Value
    }
    if ($registeredSid -ne $systemSid) {
        throw "The startup task was created with an unexpected account SID: $registeredSid"
    }
    Write-Host "Registered and verified SYSTEM startup task: $TaskName"
}

Write-Host ""
Write-Host "Installation complete."
Write-Host "Configuration: $ConfigPath"
Write-Host "LAN stream URL: $($config.gateway.publicBaseUrl)"
Write-Host "Run diagnostics: node `"$(Join-Path $projectRoot 'torrent-jellyfin.mjs')`" doctor --config `"$ConfigPath`""
Write-Host "Start manually:  node `"$(Join-Path $projectRoot 'torrent-jellyfin.mjs')`" run --config `"$ConfigPath`""
