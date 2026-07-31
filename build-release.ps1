[CmdletBinding()]
param(
    [string]$Version,
    [string]$OutputDirectory,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = Join-Path $projectRoot "dist" }
$package = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = "v$($package.version)" }
if ($Version -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw "Version must look like v1.0.0 or v1.0.0-rc.1."
}

$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$zipPath = Join-Path $OutputDirectory "jellyfin-torrent-streamer-$Version.zip"
if (Test-Path -LiteralPath $zipPath) {
    if (-not $Force) { throw "Release archive already exists: $zipPath. Use -Force to replace it." }
    Remove-Item -LiteralPath $zipPath -Force
}

$allowlist = @(
    ".gitignore",
    ".gitattributes",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "SECURITY.md",
    "README.md",
    "README.en.md",
    "package.json",
    "config.example.json",
    "torrent-jellyfin.mjs",
    "install.ps1",
    "restart.ps1",
    "doctor-elevated.ps1",
    "uninstall.ps1",
    "build-release.ps1",
    "test",
    "tools"
)

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("jellyfin-torrent-streamer-release-" + [Guid]::NewGuid().ToString("N"))
$stagingRoot = Join-Path $temporaryRoot "jellyfin-torrent-streamer-$Version"

try {
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
    foreach ($relativePath in $allowlist) {
        $source = Join-Path $projectRoot $relativePath
        if (-not (Test-Path -LiteralPath $source)) { throw "Allowlisted release file is missing: $relativePath" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $stagingRoot $relativePath) -Recurse
    }

    $files = @(Get-ChildItem -LiteralPath $stagingRoot -File -Recurse)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($stagingRoot.Length).TrimStart([char[]]@('\', '/')).Replace('\', '/')
        if ($relative -match '(^|/)(config\.json|data|bin|library)(/|$)' -or
            $relative -match '\.(torrent|strm|db|log|exe)$' -or
            $relative -match '(^|/)\.env(?:\.|$)' -or
            $relative -match '\.tmp-') {
            throw "Forbidden release entry: $relative"
        }

        if ($file.Extension -match '^\.(md|json|mjs|ps1|yml|yaml|txt)$') {
            $content = Get-Content -LiteralPath $file.FullName -Raw
            if ($content -match '/stream/[A-Za-z0-9_-]{20,}/[a-fA-F0-9]{40}/[0-9]+/') {
                throw "A URL resembling a real gateway token was found in release file: $relative"
            }
        }
    }

    Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name -match '(^|/)(config\.json|data|bin|library)(/|$)' -or
                $name -match '\.(torrent|strm|db|log|exe)$' -or
                $name -match '(^|/)\.env(?:\.|$)' -or
                $name -match '\.tmp-') {
                throw "Forbidden ZIP entry: $name"
            }
        }
    }
    finally {
        $archive.Dispose()
    }

    $hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    Write-Host "Release archive: $zipPath"
    Write-Host "SHA-256: $hash"
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
        $systemTemporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (-not $resolvedTemporary.StartsWith($systemTemporary, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove an unexpected temporary path: $resolvedTemporary"
        }
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
}
