# jellyfin-torrent-streamer

[Документация на русском](README.md)

A Windows-only Node.js utility that imports `.torrent` files into a local TorrServer instance and generates a Jellyfin `.strm` library. Jellyfin receives an ordinary seekable HTTP stream without downloading the complete video first.

> Use this project only with content you are legally allowed to download and share. The repository contains no content catalog, torrent files, or TorrServer binary.

## Data flow

```text
data\inbox -> TorrServer on 127.0.0.1:8090 -> rolling disk cache
     |             |
     |             +-> authenticated LAN stream gateway on :8091
     +-> data\processed + .strm files -> Jellyfin -> GET/HEAD/Range
```

The watcher scans the inbox every 10 seconds and waits 2 seconds for a file to stabilize. Successful torrents are archived in `data\processed`; failed imports go to `data\failed`. `data\state\imports.json` is written atomically and makes imports idempotent.

TorrServer's API stays on loopback. Only `GET` and `HEAD` requests matching `/stream/<token>/<hash>/<index>/<filename>` are exposed to the trusted LAN. The gateway forwards `Range`, `Content-Range`, content type, and client cancellation. TorrServer downloads only the pieces needed for playback and seeking.

## Requirements

- Windows 10/11 x64;
- Node.js 20 or newer;
- PowerShell 5.1 or 7;
- Jellyfin and the gateway on the same computer;
- trusted LAN connectivity and a torrent with available peers.

There are no npm runtime dependencies. The installer downloads the official pinned `TorrServer-windows-amd64.exe` `MatriX.142.2` release separately and verifies its GitHub-published SHA-256 digest. The binary is never included in Git or the release ZIP.

## Install

Use an elevated PowerShell window when requesting the startup task or Firewall rule:

```powershell
git clone https://github.com/nelidgc/jellyfin-torrent-streamer.git
cd jellyfin-torrent-streamer

Set-ExecutionPolicy -Scope Process Bypass

.\install.ps1 `
  -LibraryPath "D:\MediaServer\media" `
  -CachePath "D:\TorrServerCache" `
  -CacheSizeGB 20 `
  -ConfigureFirewall `
  -RegisterTask
```

Override automatic physical LAN detection if necessary:

```powershell
.\install.ps1 -LanAddress "192.168.1.20" -ConfigureFirewall -RegisterTask
```

The installer creates `config.json` on first install, generates a random 256-bit gateway token, creates the optional LocalSubnet-only Firewall rule, registers an optional `SYSTEM` startup task, and downloads a verified TorrServer binary. On an existing installation, library, cache, cache size, and LAN values change only when their corresponding parameters are explicitly supplied. `-Force` only permits replacement of a mismatched TorrServer executable.

Broad inbound Windows Firewall rules for Node.js are reported but left untouched. Disable them only with the explicit `-RestrictBroadNodeFirewall` switch.

The default pin is `MatriX.142.2`. A verified upgrade may override it only by passing both `-TorrServerVersion MatriX.X` and `-TorrServerSha256 <64-character-SHA256>`. The installer rejects either parameter on its own; obtain the digest from the official GitHub Release.

Run diagnostics after installation:

```powershell
node .\torrent-jellyfin.mjs doctor
```

Create two Jellyfin libraries:

- Movies: `<paths.library>\<library.moviesFolder>`;
- TV Shows: `<paths.library>\<library.showsFolder>`.

For the example above these are `D:\MediaServer\media\movies` and `D:\MediaServer\media\tv`.

## Import and commands

Drop a `.torrent` into `data\inbox`, or run:

```powershell
node .\torrent-jellyfin.mjs import "D:\Downloads\example.torrent"
```

```powershell
node .\torrent-jellyfin.mjs run
node .\torrent-jellyfin.mjs doctor
node .\torrent-jellyfin.mjs rebuild --dry-run
node .\torrent-jellyfin.mjs rebuild
node .\torrent-jellyfin.mjs import "file.torrent"
```

Add `--config "D:\Config\streamer.json"` when using a non-default config path. `rebuild --dry-run` does not change STRM files, registry state, or TorrServer; it writes an atomic plan to `paths.state\rebuild-preview.json` (or `--report <file>`). The report includes old/new paths, hash, index, title source, and action. A real rebuild first backs up `imports.json`, regenerates the preview, and refuses unsafe path escapes, user-file overwrites, preview errors, or managed-entry count changes.

Episode names using `S01E02`, `S01.E02`, or `1x02` are placed under `tv\Title\Season 01`. Tracker/domain prefixes, `rutracker-ID`, and release suffixes such as resolution, source, codec, and HDR are removed. Episodes use `Title - S01E02.strm`; movies use `Title (Year)\Title (Year).strm`, which gives Jellyfin cleaner metadata identifiers.

`library.titlePreference` selects the title source. The public `metadata` default always prefers cleaned TorrServer `status.name`. `localized` selects a Cyrillic candidate only when exactly one of `status.name`, `status.title`, and the source torrent filename contains Cyrillic; ambiguous cases fall back to metadata. Preview a rebuild after changing this option.

Unrecognized show videos go into `Extras`. A `rebuild` migrates managed links to the current layout and removes an old link only after its torrent hash and file index are verified. User-edited files are not removed or overwritten; a short infohash suffix resolves collisions.

## Configuration and storage

Copy `config.example.json` or let the installer create the Git-ignored `config.json`. Paths may be absolute or relative, use different drives, and contain spaces or Unicode characters. Relative paths are resolved from the config file directory.

| Purpose | Default | Setting |
|---|---|---|
| Inbox | `data\inbox` | `paths.inbox` |
| Torrent archive | `data\processed` | `paths.processed` |
| Failed imports | `data\failed` | `paths.failed` |
| Registry/state | `data\state` | `paths.state` |
| Video cache | `data\cache` | `paths.cache` |
| Logs | `data\logs` | `paths.logs` |
| Media root | `library` | `paths.library` |
| Movies | `library\movies` | `library.moviesFolder` |
| Shows | `library\tv` | `library.showsFolder` |

The default global cache target is 20 GiB. Every five minutes the built-in LRU janitor measures all infohash directories and, when over target, removes the oldest inactive directories after a 60-second grace period. Cache scanning and removal are completely skipped while an HTTP stream is active. Active torrent directories are never removed, so active streams can temporarily exceed the target. `connectionsLimit: 100` and `readerReadAheadPercent: 100` improve forward loading for large 4K streams. `torrentDisconnectTimeoutSeconds: 600` keeps discovered peers for ten minutes after the last request, avoiding a cold swarm restart on retries, seeks, and nearby playback. The cache is disposable. Preserve `config.json`, `data\processed`, and `data\state` for backup or migration; cache and logs do not need backup.

Metadata warmup reads `metadataWarmupBytes` from the beginning and end of every video only while no user stream is active. New imports are queued automatically. `metadataWarmupRecentTorrents` controls how many recent torrents are queued after startup and defaults to `0` publicly to avoid unexpected background traffic. An active playback request immediately cancels warmup, which is retried when the gateway becomes idle.

`uploadRateLimit` and `downloadRateLimit` use KiB/s: `null` preserves the TorrServer setting, `0` means unlimited, and a positive integer applies a limit. `disableUpload: null` also preserves the current value. Do not set `disableUpload: true` casually: private trackers can require uploading and penalize poor ratios. `watch.peerCheckMs` controls the background connected-peer check after import; `totalPeers` alone does not mean a connection is active.

To move the media root, update `paths.library` (or rerun `install.ps1 -LibraryPath ...`), run `.\restart.ps1`, run `rebuild`, add the new Movies/TV paths to Jellyfin, and verify them. Remove the old managed `.strm` tree manually only after verification.

To clear cache, stop the service, verify the exact `paths.cache` directory, delete only its contents, and restart. Do not remove state or processed torrents when restoration is required.

## Network, Firewall, and VPN

- Keep the TorrServer API on `127.0.0.1:8090`.
- Expose the token gateway only on the physical LAN address and TCP 8091.
- Do not port-forward either port to the internet.
- Treat the token, `config.json`, `.strm` URLs, and URL-bearing logs as secrets. Jellyfin and its FFmpeg process may copy the token-bearing URL into their logs; restrict log access and rotate the token after disclosure.
- Reserve the server IPv4 address with DHCP. After an address change, rerun `install.ps1 -LanAddress <address>` and `rebuild`.

`torrServer.peerBindAddress` binds BitTorrent sockets to a physical address, but it does not guarantee split tunneling. With force-tunnel VPN software, manually put the full path to `TorrServer.exe` in the VPN client's Direct/Bypass/Excluded-app list. This project never edits third-party VPN settings. Verify the actual route and public egress address using your VPN vendor's procedure; successful LAN playback does not prove how peer traffic exits.

## Troubleshooting

```powershell
node .\torrent-jellyfin.mjs doctor
Get-Content .\data\logs\torrent-jellyfin.log -Tail 100
```

- A torrent missing from inbox should be in `processed` after success or `failed` after an error.
- If Jellyfin sees no folders, verify `paths.library`, `moviesFolder`, and `showsFolder`, run `rebuild`, then rescan Jellyfin.
- Open a `.strm` as text and test its private URL with `curl.exe -I "URL"`; expect `200 OK` with the full `Content-Length`.
- Test seeking with `curl.exe -H "Range: bytes=0-1048575" -D - -o NUL "URL"`; expect `206 Partial Content` and `Content-Range`.
- `404` means the token/hash/index is unknown; `503` means TorrServer is unavailable.
- A timeout commonly indicates no seeders or unavailable pieces. Large 4K files can have a slow first start.
- Stream logs include `Torrent stream response`, `Torrent stream stalled`, `Torrent stream resumed`, and `Torrent stream finished`. Response entries include downstream and upstream status; stall entries include download speed, active peers/seeders, Range, and idle time. Routine client `ECONNRESET`/`EPIPE` disconnects are silently discarded, while genuine HTTP parser errors are logged.
- If the startup task is missing, run `.\install.ps1 -RegisterTask` followed by `.\restart.ps1` from elevated PowerShell.

## Uninstall

Run from elevated PowerShell:

```powershell
.\uninstall.ps1
```

The default removes the exact startup task and Firewall rule and stops managed processes, while preserving config, torrent archive, state, cache, TorrServer, and project files. `uninstall.ps1 -PurgeData` permanently deletes inbox/processed/failed/state/cache/log directories after safety checks. It never deletes `paths.library` and always preserves `config.json`.

## Development and releases

```powershell
npm test
npm run check
npm run smoke
.\build-release.ps1 -Version v1.2.0
```

`npm run smoke` uses only temporary state/cache paths and the TorrServer process it starts; it never reads local `config.json`. When `bin\TorrServer.exe` is absent (as in CI), it prints `SKIP` and exits successfully.

The release builder uses an allowlist and rejects user configuration, data, torrents, streams, databases, logs, and executables. GitHub Actions tests Node.js 20/22/24 on `windows-latest`, parses all PowerShell files, and creates a sanitized ZIP for `v*` tags.

Before publishing, explicitly stage public files and inspect `git diff --cached`; never stage local `config.json`, `data`, `bin`, `.torrent`, `.strm`, `.db`, `.log`, `.exe`, or a real gateway token.

## Licenses

Project code is [MIT licensed](LICENSE). TorrServer is a separate GPL-3.0 component downloaded from its official release. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
