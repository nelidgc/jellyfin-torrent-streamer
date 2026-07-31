// Every test in test/ talks to a fake TorrServer: fast, deterministic, and blind to whether the
// real binary still speaks the API this tool assumes. This script drives the actual executable --
// process start, settings round-trip against the field names we write, and a gateway request --
// so a TorrServer upgrade that renames a setting fails here instead of in someone's living room.
//
// It is deliberately not part of `npm test`: starting TorrServer costs about half a minute, and
// the fetch connection pool keeps the process alive afterwards, which the test runner would sit
// and wait for. Run it with `npm run smoke` after changing anything that talks to TorrServer.
import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Logger,
  StateStore,
  StreamGateway,
  TorrServerManager,
  ensureDirectories
} from '../torrent-jellyfin.mjs'

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const EXECUTABLE = path.join(PROJECT_ROOT, 'bin', 'TorrServer.exe')
const UNKNOWN_HASH = '0123456789abcdef0123456789abcdef01234567'

const checks = []
function expect(label, actual, expected) {
  const ok = Object.is(actual, expected)
  checks.push({ label, ok })
  console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label}${ok ? '' : `: expected ${expected}, got ${actual}`}`)
}

async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function buildConfig(root, port) {
  return {
    paths: {
      inbox: path.join(root, 'inbox'),
      processed: path.join(root, 'processed'),
      failed: path.join(root, 'failed'),
      library: path.join(root, 'library'),
      state: path.join(root, 'state'),
      cache: path.join(root, 'cache'),
      logs: path.join(root, 'logs')
    },
    torrServer: {
      executable: EXECUTABLE,
      apiUrl: `http://127.0.0.1:${port}`,
      bindAddress: '127.0.0.1',
      peerBindAddress: '',
      port,
      manageProcess: true,
      startupTimeoutMs: 90000,
      requestTimeoutMs: 30000,
      cacheSizeBytes: 2147483648,
      preloadPercent: 1,
      // Deliberately non-default so a silently renamed field cannot pass by coincidence.
      uploadRateLimit: 4096,
      downloadRateLimit: 8192,
      disableUpload: true
    },
    gateway: {
      bindAddress: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://127.0.0.1:8091',
      token: 'smoke-token-with-enough-entropy',
      upstreamTimeoutMs: 10000
    },
    watch: { scanIntervalMs: 1000, stableDelayMs: 0, peerCheckMs: 0 },
    library: {
      moviesFolder: 'movies',
      showsFolder: 'tv',
      extrasFolder: 'Extras',
      videoExtensions: ['.mkv']
    }
  }
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    request.once('error', reject)
    request.end()
  })
}

async function main() {
  if (!fsSync.existsSync(EXECUTABLE)) {
    console.log(`SKIP: ${EXECUTABLE} is not installed; run install.ps1 first.`)
    return 0
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jellyfin-smoke-'))
  const config = buildConfig(root, await freePort())
  await ensureDirectories(config)
  const logger = new Logger(null, { silent: true })
  const manager = new TorrServerManager(config, logger)
  let gateway = null

  try {
    console.log(`Starting TorrServer on ${config.torrServer.apiUrl} (this takes a while)...`)
    await manager.ensureStarted()
    expect('the API answers /echo', await manager.health(), true)

    await manager.configure()
    const settings = await manager.request('/settings', { method: 'POST', body: { action: 'get' } })
    expect('CacheSize is the field TorrServer uses', settings.CacheSize, config.torrServer.cacheSizeBytes)
    expect('UseDisk is the field TorrServer uses', settings.UseDisk, true)
    expect('TorrentsSavePath is the field TorrServer uses', settings.TorrentsSavePath, config.paths.cache)
    expect('DisableUPNP is the field TorrServer uses', settings.DisableUPNP, true)
    expect('UploadRateLimit is the field TorrServer uses', settings.UploadRateLimit, 4096)
    expect('DownloadRateLimit is the field TorrServer uses', settings.DownloadRateLimit, 8192)
    expect('DisableUpload is the field TorrServer uses', settings.DisableUpload, true)

    // A second pass must be a no-op: the diff in configure() is what keeps a shared TorrServer intact.
    const before = JSON.stringify(await manager.request('/settings', { method: 'POST', body: { action: 'get' } }))
    await manager.configure()
    const after = JSON.stringify(await manager.request('/settings', { method: 'POST', body: { action: 'get' } }))
    expect('re-running configure changes nothing', after, before)

    expect('an empty torrent list is an array', Array.isArray(await manager.listTorrents()), true)
    expect('an unknown hash resolves to null', await manager.getTorrent(UNKNOWN_HASH), null)

    const stateStore = new StateStore(config.paths.state)
    await stateStore.load()
    gateway = new StreamGateway(config, stateStore, logger)
    const address = await gateway.start()
    expect('a hash outside the registry never reaches TorrServer',
      await get(address.port, `/stream/${config.gateway.token}/${UNKNOWN_HASH}/0/video.mkv`), 404)
    expect('a wrong token is refused',
      await get(address.port, `/stream/wrong-token/${UNKNOWN_HASH}/0/video.mkv`), 404)
    expect('TorrServer survived the requests', await manager.health(), true)
  } finally {
    await gateway?.stop()
    await manager.stop()
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }

  const failed = checks.filter((entry) => !entry.ok)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed against the real TorrServer.`)
  return failed.length === 0 ? 0 : 1
}

// The fetch connection pool outlives the last request, so the exit code is set explicitly instead
// of waiting for an event loop that has nothing left to do but will not drain.
main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`SMOKE FAILED: ${error.stack || error.message}`)
    process.exit(1)
  }
)
