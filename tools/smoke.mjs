import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
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

async function freePort() {
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function request({ port, pathname, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.once('error', reject)
    req.end()
  })
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(projectRoot, 'bin', 'TorrServer.exe')
if (!await fs.stat(executable).then((stat) => stat.isFile()).catch(() => false)) {
  console.log('SKIP smoke: bin\\TorrServer.exe is not installed')
  process.exit(0)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jellyfin-torrent-smoke-'))
const apiPort = await freePort()
const gatewayPort = await freePort()
const config = {
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
    executable,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    bindAddress: '127.0.0.1',
    peerBindAddress: '',
    port: apiPort,
    manageProcess: true,
    startupTimeoutMs: 30000,
    requestTimeoutMs: 30000,
    cacheSizeBytes: 64 * 1024 * 1024,
    cacheCleanupIntervalMs: 300000,
    cacheInactiveGraceMs: 60000,
    connectionsLimit: 37,
    readerReadAheadPercent: 23,
    preloadPercent: 2,
    responsiveMode: true,
    metadataWarmupBytes: 0,
    metadataWarmupRecentTorrents: 0,
    metadataWarmupTimeoutMs: 30000,
    torrentDisconnectTimeoutSeconds: 321,
    uploadRateLimit: 0,
    downloadRateLimit: 12345,
    disableUpload: false,
    disableUpnp: false
  },
  gateway: {
    bindAddress: '127.0.0.1',
    port: gatewayPort,
    publicBaseUrl: `http://127.0.0.1:${gatewayPort}`,
    token: 'isolated-smoke-token-not-from-config',
    upstreamTimeoutMs: 30000,
    stallWarningMs: 1000
  },
  watch: { scanIntervalMs: 10000, stableDelayMs: 0, peerCheckMs: 0 },
  library: {
    moviesFolder: 'movies',
    showsFolder: 'tv',
    extrasFolder: 'Extras',
    titlePreference: 'metadata',
    videoExtensions: ['.mkv']
  }
}

await ensureDirectories(config)
const logger = new Logger(config.paths.logs, { silent: false })
const stateStore = new StateStore(config.paths.state)
await stateStore.load()
const manager = new TorrServerManager(config, logger)
let gateway = null

try {
  assert.equal(await manager.ensureStarted(), true, 'smoke must start its own TorrServer process')
  const configured = await manager.configure()
  assert.equal(configured.CacheSize, config.torrServer.cacheSizeBytes)
  assert.equal(configured.UseDisk, true)
  assert.equal(path.resolve(configured.TorrentsSavePath), path.resolve(config.paths.cache))
  assert.equal(configured.RemoveCacheOnDrop, false)
  assert.equal(configured.PreloadCache, config.torrServer.preloadPercent)
  assert.equal(configured.ConnectionsLimit, config.torrServer.connectionsLimit)
  assert.equal(configured.ReaderReadAHead, config.torrServer.readerReadAheadPercent)
  assert.equal(configured.ResponsiveMode, config.torrServer.responsiveMode)
  assert.equal(configured.TorrentDisconnectTimeout, config.torrServer.torrentDisconnectTimeoutSeconds)
  assert.equal(configured.DisableUPNP, config.torrServer.disableUpnp)
  assert.equal(configured.UploadRateLimit, config.torrServer.uploadRateLimit)
  assert.equal(configured.DownloadRateLimit, config.torrServer.downloadRateLimit)
  assert.equal(configured.DisableUpload, config.torrServer.disableUpload)

  let setCalls = 0
  const originalRequest = manager.request.bind(manager)
  manager.request = async (endpoint, options = {}) => {
    if (endpoint === '/settings' && options.body?.action === 'set') setCalls += 1
    return originalRequest(endpoint, options)
  }
  await manager.configure()
  assert.equal(setCalls, 0, 'second configure() must be a no-op')
  assert.deepEqual(await manager.listTorrents(), [])

  gateway = new StreamGateway(config, stateStore, logger, manager)
  await gateway.start()
  const unknown = await request({
    port: gatewayPort,
    pathname: `/stream/${config.gateway.token}/0123456789abcdef0123456789abcdef01234567/0/test.mkv`
  })
  assert.equal(unknown.status, 404)
  const denied = await request({
    port: gatewayPort,
    pathname: '/stream/wrong-token/0123456789abcdef0123456789abcdef01234567/0/test.mkv'
  })
  assert.equal(denied.status, 404)
  console.log('PASS smoke: isolated TorrServer settings, configure no-op, and gateway protection')
} finally {
  await gateway?.stop().catch(() => {})
  await manager.stop().catch(() => {})
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}
