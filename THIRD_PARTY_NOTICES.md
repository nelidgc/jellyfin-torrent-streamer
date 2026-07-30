# Third-party notices

## TorrServer

jellyfin-torrent-streamer integrates with TorrServer as a separate executable through its local HTTP API.

- Project: [YouROK/TorrServer](https://github.com/YouROK/TorrServer)
- Pinned installer release: [MatriX.142.2](https://github.com/YouROK/TorrServer/releases/tag/MatriX.142.2)
- Pinned Windows amd64 SHA-256: `BDC6E80DA81918A19D8A74D8FE43A6C1FC584889CB43DE66D573D735F2209A5E`
- License: [GNU General Public License v3.0](https://github.com/YouROK/TorrServer/blob/master/LICENSE)
- Source corresponding to the pinned release: [MatriX.142.2 source archive](https://github.com/YouROK/TorrServer/tree/MatriX.142.2)

The TorrServer binary is not part of this repository and is not included in jellyfin-torrent-streamer release archives. `install.ps1` downloads `TorrServer-windows-amd64.exe` directly from the official GitHub Release and validates the SHA-256 digest published in the release asset metadata before installation.

TorrServer remains governed by GPL-3.0. The MIT license in this repository applies only to jellyfin-torrent-streamer's own code and documentation.
