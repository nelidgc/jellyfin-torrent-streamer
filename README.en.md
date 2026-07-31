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
git clone https://github.com/OWNER/jellyfin-torrent-streamer.git
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
node .\torrent-jellyfin.mjs rebuild
node .\torrent-jellyfin.mjs import "file.torrent"
```

Add `--config "D:\Config\streamer.json"` when using a non-default config path. `rebuild` recreates managed links from state and archived torrents but deliberately does not remove an old library tree.

The title is chosen between two sources -- the torrent metadata and the `.torrent` file name -- because either one can be the transliterated side:

```text
.torrent "[rutor.is]CHerepashki-nindzya.2014"  metadata "Черепашки-ниндзя.2014.avi"
.torrent "[GTorrent.cc]_Черепашки-ниндзя"      metadata "Cherepashki.Ninz9.2014.avi"
```

A transliteration is always plain ASCII while the title it stands in for is not, so when exactly one side carries non-ASCII letters that side wins; with no such signal the torrent's own metadata wins. When both sides are Latin and one is a transliteration, no signal exists and only a manual title settles it.

Episode names using `S01E02`, `S01.E02`, or `1x02` are placed under `tv\Title\Season 01`. Single and non-episode videos go under `movies\Torrent title`. Unrecognized show videos go into `Extras`. Existing user files are never overwritten; a short infohash suffix resolves collisions.

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

The default cache target is 20 GiB with 1% preload. This is not a strict filesystem quota; active streams and delayed eviction may temporarily exceed it. The cache is disposable. Preserve `config.json`, `data\processed`, and `data\state` for backup or migration; cache and logs do not need backup.

To move the media root, update `paths.library` (or rerun `install.ps1 -LibraryPath ...`), run `.\restart.ps1`, run `rebuild`, add the new Movies/TV paths to Jellyfin, and verify them. Remove the old managed `.strm` tree manually only after verification.

To clear cache, stop the service, verify the exact `paths.cache` directory, delete only its contents, and restart. Do not remove state or processed torrents when restoration is required.

## Network, Firewall, and VPN

- Keep the TorrServer API on `127.0.0.1:8090`.
- Expose the token gateway only on the physical LAN address and TCP 8091.
- Do not port-forward either port to the internet.
- Treat the token, `config.json`, `.strm` URLs, and URL-bearing logs as secrets.
- Reserve the server IPv4 address with DHCP. After an address change, rerun `install.ps1 -LanAddress <address>` and `rebuild`.

`torrServer.peerBindAddress` binds BitTorrent sockets to a physical address, but it does not guarantee split tunneling. With force-tunnel VPN software, manually put the full path to `TorrServer.exe` in the VPN client's Direct/Bypass/Excluded-app list. This project never edits third-party VPN settings. Verify the actual route and public egress address using your VPN vendor's procedure; successful LAN playback does not prove how peer traffic exits.

## Troubleshooting

```powershell
node .\torrent-jellyfin.mjs doctor
Get-Content .\data\logs\torrent-jellyfin.log -Tail 100
```

- A torrent missing from inbox should be in `processed` after success or `failed` after an error.
- If Jellyfin sees no folders, verify `paths.library`, `moviesFolder`, and `showsFolder`, run `rebuild`, then rescan Jellyfin.
- Open a `.strm` as text and test its private URL with `curl.exe -I "URL"`.
- Test seeking with `curl.exe -H "Range: bytes=0-1048575" -D - -o NUL "URL"`; expect `206 Partial Content` and `Content-Range`.
- `404` means the token/hash/index is unknown; `503` means TorrServer is unavailable.
- A timeout commonly indicates no seeders or unavailable pieces. Large 4K files can have a slow first start.

## Uninstall

Run from elevated PowerShell:

```powershell
.\uninstall.ps1
```

The default removes the exact startup task and Firewall rule and stops managed processes, while preserving config, torrent archive, state, cache, TorrServer, and project files. `uninstall.ps1 -PurgeData` permanently deletes inbox/processed/failed/state/cache/log directories after safety checks. It never deletes `paths.library` and always preserves `config.json`.

## Development and releases

```powershell
npm test
npm run smoke
npm run check
.\build-release.ps1 -Version v1.0.0
```

`npm test` runs against a fake TorrServer: fast and offline. `npm run smoke` starts the real `bin\TorrServer.exe` in a temporary directory and verifies that the setting names this tool writes still exist in that build; without the binary it prints `SKIP` and exits zero.

The release builder uses an allowlist and rejects user configuration, data, torrents, streams, databases, logs, and executables. GitHub Actions tests Node.js 20/22/24 on `windows-latest`, parses all PowerShell files, and creates a sanitized ZIP for `v*` tags.

Before publishing, explicitly stage public files and inspect `git diff --cached`; never stage local `config.json`, `data`, `bin`, `.torrent`, `.strm`, `.db`, `.log`, `.exe`, or a real gateway token.

## Licenses

Project code is [MIT licensed](LICENSE). TorrServer is a separate GPL-3.0 component downloaded from its official release. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
