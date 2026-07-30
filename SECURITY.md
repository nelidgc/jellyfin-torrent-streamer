# Security policy

## Supported versions

Security fixes are provided for the latest tagged release. The project supports Windows 10/11 and maintained Node.js releases starting with Node.js 20.

## Deployment boundary

This software is designed for a trusted home LAN. It is not an internet-facing streaming service.

- Keep TorrServer bound to `127.0.0.1:8090`.
- Limit gateway port 8091 to `LocalSubnet`; do not configure router port forwarding.
- Treat `config.json`, gateway tokens, `.strm` URLs, and URL-bearing logs as secrets.
- Use a long randomly generated token and rotate it if exposed. After rotation, run `rebuild` so managed `.strm` files receive the new URL.
- Do not commit `config.json`, `data`, `.torrent`, `.strm`, databases, logs, cache, or third-party executables.
- Review enabled Windows Firewall rules. `install.ps1` does not disable broad Node.js rules unless `-RestrictBroadNodeFirewall` is explicitly supplied.

`peerBindAddress` is not a security boundary and does not guarantee VPN split tunneling. Configure Direct/Bypass routing in the VPN client and independently verify the peer traffic route.

## Reporting a vulnerability

Prefer GitHub Private Vulnerability Reporting when it is enabled for the repository. Otherwise open a minimal issue asking for a private contact channel. Do not include a real token, private `.strm` URL, torrent metadata, public IP address, or personal log archive in a public issue.

Include the affected release, Windows and Node.js versions, expected security boundary, and a minimal reproduction using synthetic or legally distributable data.

## Installer trust

TorrServer is downloaded only from the pinned official GitHub Release. Installation fails closed when GitHub does not provide a valid SHA-256 asset digest or when the downloaded digest differs. The third-party executable is not covered by this project's MIT license; see `THIRD_PARTY_NOTICES.md`.
