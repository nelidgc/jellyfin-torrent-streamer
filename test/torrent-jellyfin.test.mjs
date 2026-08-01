import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  CacheJanitor,
  Logger,
  InboxWatcher,
  MetadataWarmup,
  StateStore,
  StreamGateway,
  TorrentImporter,
  TorrServerManager,
  buildStreamUrl,
  deriveMovieTitle,
  deriveSeriesTitle,
  ensureDirectories,
  loadConfig,
  parseEpisode,
  planLibraryEntries,
  sanitizePathSegment
} from '../torrent-jellyfin.mjs'

const HASH = '0123456789abcdef0123456789abcdef01234567'

async function createFixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jellyfin-torrent-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
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
      executable: path.join(root, 'TorrServer.exe'),
      apiUrl: 'http://127.0.0.1:8090',
      bindAddress: '127.0.0.1',
      peerBindAddress: '',
      port: 8090,
      manageProcess: false,
      startupTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      cacheSizeBytes: 21474836480,
      cacheCleanupIntervalMs: 300000,
      cacheInactiveGraceMs: 60000,
      connectionsLimit: 100,
      readerReadAheadPercent: 100,
      preloadPercent: 1,
      metadataWarmupBytes: 4194304,
      metadataWarmupRecentTorrents: 0,
      metadataWarmupTimeoutMs: 120000,
      torrentDisconnectTimeoutSeconds: 600
    },
    gateway: {
      bindAddress: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://192.168.1.50:8091',
      token: 'test-token-with-enough-entropy',
      upstreamTimeoutMs: 2000,
      stallWarningMs: 500
    },
    watch: { scanIntervalMs: 1000, stableDelayMs: 0 },
    library: {
      moviesFolder: 'Movies',
      showsFolder: 'TV Shows',
      extrasFolder: 'Extras',
      videoExtensions: ['.mkv', '.mp4', '.avi']
    }
  }
  Object.assign(config, overrides)
  await ensureDirectories(config)
  const stateStore = new StateStore(config.paths.state)
  await stateStore.load()
  const logger = new Logger(null, { silent: true })
  return { root, config, stateStore, logger }
}

test('episode parser recognizes common Jellyfin naming patterns', () => {
  assert.deepEqual(parseEpisode('Example.Show.S01E02.1080p.mkv'), {
    season: 1,
    episode: 2,
    endEpisode: null,
    matchIndex: 12
  })
  assert.equal(parseEpisode('Example S02.E003.mp4').season, 2)
  assert.equal(parseEpisode('Example.Show.3x07.avi').episode, 7)
  assert.equal(parseEpisode('ordinary-movie.mkv'), null)
})

test('Windows path sanitization handles invalid and reserved names', () => {
  assert.equal(sanitizePathSegment('  Movie: Name?  '), 'Movie Name')
  assert.equal(sanitizePathSegment('CON'), '_CON')
  assert.equal(sanitizePathSegment('...'), 'Untitled')
})

test('release titles are reduced to Jellyfin-friendly movie and series names', () => {
  assert.equal(
    deriveSeriesTitle('Отчаянные домохозяйки Desperate Housewives Сезон 1 Серии 1-23 из 23 (Дэвид Гроссман) [2004-2005, WEB-DL 1080p]'),
    'Отчаянные домохозяйки'
  )
  assert.equal(
    deriveMovieTitle('Супергёрл Supergirl (Крэйг Гиллеспи Craig Gillespie) [2026, США, WEB-DL 2160p, HDR10] [rutracker-6888086]'),
    'Супергёрл (2026)'
  )
  assert.equal(deriveMovieTitle('Supergirl.2026.2160p.WEB-DL.H265.DV.HDR'), 'Supergirl (2026)')
  assert.equal(deriveSeriesTitle('Another.Show.Season.03.2160p'), 'Another Show')
})

test('configuration loader resolves relative paths and rejects placeholder tokens', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jellyfin-config-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const template = JSON.parse(await fs.readFile(new URL('../config.example.json', import.meta.url), 'utf8'))
  template.gateway.token = 'configured-test-token'
  const configFile = path.join(root, 'config.json')
  await fs.writeFile(configFile, JSON.stringify(template))
  const loaded = await loadConfig(configFile)
  assert.equal(loaded.paths.inbox, path.join(root, 'data', 'inbox'))
  assert.equal(loaded.torrServer.executable, path.join(root, 'bin', 'TorrServer.exe'))
  assert.equal(loaded.torrServer.peerBindAddress, '')
  assert.equal(loaded.torrServer.cacheCleanupIntervalMs, 300000)
  assert.equal(loaded.torrServer.connectionsLimit, 100)
  assert.equal(loaded.torrServer.readerReadAheadPercent, 100)
  assert.equal(loaded.torrServer.metadataWarmupBytes, 4194304)
  assert.equal(loaded.torrServer.metadataWarmupRecentTorrents, 0)
  assert.equal(loaded.torrServer.torrentDisconnectTimeoutSeconds, 600)
  assert.equal(loaded.gateway.stallWarningMs, 15000)

  template.gateway.token = 'CHANGE_ME'
  await fs.writeFile(configFile, JSON.stringify(template))
  await assert.rejects(loadConfig(configFile), /gateway\.token is not configured/)
})

test('configuration supports spaces, Cyrillic paths, and media/cache on different drives', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'настройки с пробелами-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const template = JSON.parse(await fs.readFile(new URL('../config.example.json', import.meta.url), 'utf8'))
  template.gateway.token = 'configured-test-token'
  template.paths.inbox = './данные с пробелами/inbox'
  template.paths.library = 'D:\\Медиатека Jellyfin'
  template.paths.cache = 'F:\\Кэш TorrServer'
  const configFile = path.join(root, 'конфигурация.json')
  await fs.writeFile(configFile, JSON.stringify(template))

  const loaded = await loadConfig(configFile)
  assert.equal(loaded.paths.inbox, path.join(root, 'данные с пробелами', 'inbox'))
  assert.equal(loaded.paths.library, path.normalize('D:\\Медиатека Jellyfin'))
  assert.equal(loaded.paths.cache, path.normalize('F:\\Кэш TorrServer'))
})

test('library planner preserves Unicode names under a custom media root', async (t) => {
  const { config } = await createFixture(t)
  config.paths.library = path.normalize('D:\\Медиатека Jellyfin')
  config.library.moviesFolder = 'Фильмы для семьи'
  const planned = planLibraryEntries({
    hash: HASH,
    title: 'Проверочный фильм 2026',
    name: 'Проверочный фильм 2026',
    files: [{ index: 2, path: 'Проверочный фильм/Фильм с пробелами.mkv', length: 100 }]
  }, 'проверка.torrent', config)

  assert.equal(planned.length, 1)
  assert.match(planned[0].target, /Медиатека Jellyfin[\\/]Фильмы для семьи[\\/]Проверочный фильм \(2026\)[\\/]Проверочный фильм \(2026\)\.strm$/)
  assert.match(planned[0].url, /%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC%20%D1%81%20%D0%BF%D1%80%D0%BE%D0%B1%D0%B5%D0%BB%D0%B0%D0%BC%D0%B8\.mkv$/)
})

test('series and movie plans produce Jellyfin-compatible paths and URLs', async (t) => {
  const { config } = await createFixture(t)
  const series = planLibraryEntries({
    hash: HASH,
    title: 'Example.Show.S01.1080p',
    name: 'Example.Show.S01',
    files: [
      { index: 0, path: 'Example.Show.S01/Example.Show.S01E01.mkv', length: 100 },
      { index: 1, path: 'Example.Show.S01/Behind the scenes.mp4', length: 50 },
      { index: 2, path: 'Example.Show.S01/readme.txt', length: 10 }
    ]
  }, 'series.torrent', config)
  assert.match(series[0].target, /TV Shows[\\/]Example Show[\\/]Season 01[\\/]Example Show - S01E01\.strm$/)
  assert.match(series[1].target, /TV Shows[\\/]Example Show[\\/]Extras[\\/]Behind the scenes\.strm$/)
  assert.equal(series.length, 2)
  assert.equal(series[0].url, buildStreamUrl(config, HASH, 0, 'Example.Show.S01E01.mkv'))

  const movie = planLibraryEntries({
    hash: HASH,
    title: 'Example.Movie.2026',
    name: 'Example.Movie.2026',
    files: [{ index: 4, path: 'Example.Movie.2026/Example.Movie.2026.mkv', length: 500 }]
  }, 'movie.torrent', config)
  assert.match(movie[0].target, /Movies[\\/]Example Movie \(2026\)[\\/]Example Movie \(2026\)\.strm$/)
  assert.equal(deriveSeriesTitle('Another.Show.S03.2160p'), 'Another Show')
})

test('Rutracker-style names create short episode paths that Jellyfin can identify', async (t) => {
  const { config } = await createFixture(t)
  config.library.showsFolder = 'tv'
  const planned = planLibraryEntries({
    hash: HASH,
    title: 'Ранчо Даттонов Dutton Ranch Сезон 1 Серии 1-9 из 9 (Кристина Ворос) [2026, США, WEB-DL 2160p, HDR10] [rutracker-6859332]',
    name: 'Dutton.Ranch.S01.2160p.ATV.WEB-DL.DV.HDR.H.265',
    files: [{
      index: 4,
      path: 'Dutton.Ranch.S01.2160p.ATV.WEB-DL.DV.HDR.H.265/Dutton.Ranch.S01E04.2160p.ATV.WEB-DL.DV.HDR.H.265.RGzsRutracker.mkv',
      length: 100
    }]
  }, 'ranch.torrent', config)

  assert.match(planned[0].target, /tv[\\/]Ранчо Даттонов[\\/]Season 01[\\/]Ранчо Даттонов - S01E04\.strm$/)
})

test('import is idempotent, archives the torrent, and preserves user conflicts', async (t) => {
  const { config, stateStore, logger } = await createFixture(t)
  const status = {
    hash: HASH,
    title: 'Example.Movie.2026',
    name: 'Example.Movie.2026',
    files: [{ index: 0, path: 'Example.Movie.2026/Example.Movie.2026.mkv', length: 500 }]
  }
  const manager = {
    uploadTorrent: async () => status,
    getTorrent: async () => status
  }
  const importer = new TorrentImporter(config, manager, stateStore, logger)
  const expected = planLibraryEntries(status, 'movie.torrent', config)[0].target
  await fs.mkdir(path.dirname(expected), { recursive: true })
  await fs.writeFile(expected, 'user-owned-content\n')

  const firstInput = path.join(config.paths.inbox, 'movie.torrent')
  await fs.writeFile(firstInput, 'torrent-fixture')
  const first = await importer.processFile(firstInput)
  assert.equal(first.files.length, 1)
  assert.match(first.files[0].relativeOutput, /\[01234567\]\.strm$/)
  assert.equal(await fs.readFile(expected, 'utf8'), 'user-owned-content\n')
  const managedOutput = path.join(config.paths.library, first.files[0].relativeOutput)
  assert.match(await fs.readFile(managedOutput, 'utf8'), /\/stream\/test-token-with-enough-entropy\//)
  assert.equal((await fs.readdir(config.paths.processed)).filter((name) => name.endsWith('.torrent')).length, 1)

  const secondInput = path.join(config.paths.inbox, 'movie.torrent')
  await fs.writeFile(secondInput, 'torrent-fixture')
  const second = await importer.processFile(secondInput)
  assert.equal(second.files[0].relativeOutput, first.files[0].relativeOutput)
  assert.equal((await fs.readdir(config.paths.processed)).filter((name) => name.endsWith('.torrent')).length, 1)
  assert.equal(stateStore.list().length, 1)
})

test('rebuild follows renamed library folders instead of preserving the old layout', async (t) => {
  const { config, stateStore, logger } = await createFixture(t)
  config.library.showsFolder = 'tv'
  const status = {
    hash: HASH,
    title: 'Moved.Show.S02',
    name: 'Moved.Show.S02',
    files: [{ index: 0, path: 'Moved.Show.S02E01.mkv', length: 100 }]
  }
  const oldRecord = {
    hash: HASH,
    title: status.title,
    name: status.name,
    sourceName: 'moved-show.torrent',
    files: [{
      index: 0,
      sourcePath: status.files[0].path,
      length: 100,
      relativeOutput: path.join('TV Shows', 'Moved Show', 'Season 02', 'Moved.Show.S02E01.strm')
    }]
  }
  const importer = new TorrentImporter(config, { getTorrent: async () => status }, stateStore, logger)
  const oldTarget = path.join(config.paths.library, oldRecord.files[0].relativeOutput)
  await fs.mkdir(path.dirname(oldTarget), { recursive: true })
  await fs.writeFile(oldTarget, `${buildStreamUrl(config, HASH, 0, status.files[0].path)}${os.EOL}`)
  const updated = await importer.rebuildRecord(oldRecord)

  assert.match(updated.files[0].relativeOutput, /^tv[\\/]Moved Show[\\/]Season 02[\\/]/)
  assert.equal(await fs.readFile(path.join(config.paths.library, updated.files[0].relativeOutput), 'utf8'), `${buildStreamUrl(config, HASH, 0, status.files[0].path)}${os.EOL}`)
  await assert.rejects(fs.access(oldTarget))
})

test('rebuild preserves an old STRM that was edited by the user', async (t) => {
  const { config, stateStore, logger } = await createFixture(t)
  const status = {
    hash: HASH,
    title: 'Renamed.Movie.2026.2160p.WEB-DL',
    name: 'Renamed.Movie.2026',
    files: [{ index: 0, path: 'Renamed.Movie.2026.2160p.WEB-DL.mkv', length: 100 }]
  }
  const oldRecord = {
    hash: HASH,
    title: status.title,
    name: status.name,
    sourceName: 'renamed.torrent',
    files: [{ index: 0, sourcePath: status.files[0].path, length: 100, relativeOutput: path.join('Movies', 'Old title', 'custom.strm') }]
  }
  const oldTarget = path.join(config.paths.library, oldRecord.files[0].relativeOutput)
  await fs.mkdir(path.dirname(oldTarget), { recursive: true })
  await fs.writeFile(oldTarget, 'https://example.invalid/user-edited-video\n')
  const importer = new TorrentImporter(config, { getTorrent: async () => status }, stateStore, logger)

  const updated = await importer.rebuildRecord(oldRecord)

  assert.equal(await fs.readFile(oldTarget, 'utf8'), 'https://example.invalid/user-edited-video\n')
  assert.match(updated.files[0].relativeOutput, /Renamed Movie \(2026\)[\\/]Renamed Movie \(2026\)\.strm$/)
})

test('rebuild restores an archived torrent when TorrServer metadata is empty', async (t) => {
  const { config, stateStore, logger } = await createFixture(t)
  const archivePath = path.join(config.paths.processed, 'delayed--01234567.torrent')
  await fs.writeFile(archivePath, 'torrent-fixture')
  const completeStatus = {
    hash: HASH,
    title: 'Delayed.Movie',
    name: 'Delayed.Movie',
    files: [{ index: 0, path: 'Delayed.Movie.mkv', length: 500 }]
  }
  let restored = false
  const manager = {
    getTorrent: async () => ({ ...completeStatus, files: [] }),
    waitForFiles: async (status) => status,
    uploadTorrent: async () => {
      restored = true
      return completeStatus
    }
  }
  const importer = new TorrentImporter(config, manager, stateStore, logger)
  const updated = await importer.rebuildRecord({
    hash: HASH,
    title: completeStatus.title,
    name: completeStatus.name,
    sourceName: 'delayed.torrent',
    archivePath,
    files: []
  })

  assert.equal(restored, true)
  assert.equal(updated.files.length, 1)
})

test('failed import moves input to failed without creating STRM files', async (t) => {
  const { config, stateStore, logger } = await createFixture(t)
  const manager = {
    uploadTorrent: async () => ({ hash: HASH, title: 'No video', name: 'No video', files: [] })
  }
  const importer = new TorrentImporter(config, manager, stateStore, logger)
  const input = path.join(config.paths.inbox, 'broken.torrent')
  await fs.writeFile(input, 'broken')
  await assert.rejects(importer.processFile(input), /supported video files/)
  assert.equal((await fs.readdir(config.paths.failed)).filter((name) => name.endsWith('.torrent')).length, 1)
  assert.equal((await fs.readdir(config.paths.failed)).filter((name) => name.endsWith('.error.txt')).length, 1)
  assert.equal((await fs.readdir(config.paths.library)).length, 0)
})

test('inbox watcher imports torrents already present at startup', async (t) => {
  const { config, stateStore, logger } = await createFixture(t)
  const status = {
    hash: HASH,
    title: 'Watched.Show.S02',
    name: 'Watched.Show.S02',
    files: [{ index: 3, path: 'Watched.Show.S02E04.mkv', length: 100 }]
  }
  const manager = { uploadTorrent: async () => status, getTorrent: async () => status }
  const importer = new TorrentImporter(config, manager, stateStore, logger)
  const watcher = new InboxWatcher(config, importer, logger)
  await fs.writeFile(path.join(config.paths.inbox, 'watched.torrent'), 'torrent-fixture')
  await watcher.start()
  await watcher.stop()
  assert.equal((await fs.readdir(config.paths.inbox)).length, 0)
  assert.equal(stateStore.list().length, 1)
  assert.match(stateStore.list()[0].files[0].relativeOutput, /Season 02/)
})

test('TorrServer API client uploads multipart torrent data and surfaces API errors', async (t) => {
  let uploadBody = ''
  let configuredSettings = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      uploadBody = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/torrent/upload') {
        assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          hash: HASH,
          title: 'Uploaded movie',
          name: 'Uploaded movie',
          file_stats: [{ id: 7, path: 'Uploaded movie.mkv', length: 42 }]
        }))
      } else if (req.url === '/settings') {
        const requestBody = JSON.parse(uploadBody)
        res.writeHead(200, { 'content-type': 'application/json' })
        if (requestBody.action === 'get') {
          res.end(JSON.stringify({ CacheSize: 64, UseDisk: false, ConnectionsLimit: 25 }))
        } else {
          configuredSettings = requestBody.sets
          res.end('{}')
        }
      } else {
        res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('mock failure')
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { config, logger } = await createFixture(t)
  config.torrServer.apiUrl = `http://127.0.0.1:${server.address().port}`
  const manager = new TorrServerManager(config, logger)
  const input = path.join(config.paths.inbox, 'upload.torrent')
  await fs.writeFile(input, 'torrent-binary-fixture')

  const status = await manager.uploadTorrent(input, 'Uploaded movie')
  assert.equal(status.files[0].index, 7)
  assert.match(uploadBody, /torrent-binary-fixture/)
  assert.match(uploadBody, /Uploaded movie/)
  await manager.configure()
  assert.equal(configuredSettings.CacheSize, 21474836480)
  assert.equal(configuredSettings.UseDisk, true)
  assert.equal(configuredSettings.TorrentsSavePath, config.paths.cache)
  assert.equal(configuredSettings.PreloadCache, 1)
  assert.equal(configuredSettings.ConnectionsLimit, 100)
  assert.equal(configuredSettings.ReaderReadAHead, 100)
  assert.equal(configuredSettings.TorrentDisconnectTimeout, 600)
  assert.equal(configuredSettings.DisableUPNP, true)
  await assert.rejects(manager.request('/mock-error'), /HTTP 500: mock failure/)
})

test('TorrServer manager waits for a busy existing API instead of spawning a duplicate', async (t) => {
  const server = http.createServer((_req, res) => res.writeHead(503).end())
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const { config, logger } = await createFixture(t)
  config.torrServer.apiUrl = `http://127.0.0.1:${server.address().port}`
  config.torrServer.manageProcess = true
  await fs.writeFile(config.torrServer.executable, 'not executed')
  const manager = new TorrServerManager(config, logger)
  let healthChecks = 0
  manager.health = async () => {
    healthChecks += 1
    return healthChecks > 1
  }

  assert.equal(await manager.ensureStarted(), false)
  assert.equal(manager.child, null)
  assert.equal(healthChecks >= 2, true)
})

test('metadata warmup fetches bounded head and tail ranges', async (t) => {
  const ranges = []
  const server = http.createServer((req, res) => {
    ranges.push(req.headers.range)
    const body = Buffer.alloc(4, 1)
    res.writeHead(206, {
      'content-type': 'application/octet-stream',
      'content-length': body.length,
      'content-range': `bytes 0-3/10`
    })
    res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const { config, logger } = await createFixture(t)
  config.torrServer.apiUrl = `http://127.0.0.1:${server.address().port}`
  config.torrServer.metadataWarmupBytes = 4
  config.torrServer.metadataWarmupTimeoutMs = 1000
  const manager = new TorrServerManager(config, logger)
  const result = await manager.warmMetadata({
    hash: HASH,
    files: [{ index: 0, length: 10 }]
  })

  assert.deepEqual(ranges, ['bytes=0-3', 'bytes=6-9'])
  assert.deepEqual(result, { bytes: 8, canceled: false })
})

test('metadata warmup waits while a user stream is active', async (t) => {
  const { config, logger } = await createFixture(t)
  let streaming = true
  let calls = 0
  const manager = {
    warmMetadata: async () => {
      calls += 1
      return { bytes: 8, canceled: false }
    }
  }
  const warmup = new MetadataWarmup(config, manager, logger, () => streaming)
  warmup.start([{ hash: HASH, files: [{ index: 0, length: 10 }] }])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(calls, 0)

  streaming = false
  await warmup.running
  assert.equal(calls, 1)
  await warmup.stop()
})

function request({ port, pathname, method = 'GET', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.once('error', reject)
    req.end()
  })
}

test('gateway validates token and proxies GET Range and HEAD requests', async (t) => {
  const media = Buffer.from('0123456789')
  const upstream = http.createServer((req, res) => {
    if (req.url !== `/play/${HASH}/0`) {
      res.writeHead(404).end()
      return
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    if (match) {
      const start = Number(match[1])
      const end = match[2] ? Number(match[2]) : media.length - 1
      const body = media.subarray(start, end + 1)
      res.writeHead(206, {
        'content-type': 'video/x-matroska',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${media.length}`,
        'content-length': body.length
      })
      res.end(body)
      return
    }
    res.writeHead(200, { 'content-length': media.length, 'accept-ranges': 'bytes' })
    res.end(media)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => upstream.close(resolve)))

  const { config, stateStore, logger } = await createFixture(t)
  config.torrServer.apiUrl = `http://127.0.0.1:${upstream.address().port}`
  stateStore.data.imports[HASH] = { hash: HASH, files: [{ index: 0, relativeOutput: 'movie.strm' }] }
  const gateway = new StreamGateway(config, stateStore, logger)
  const address = await gateway.start()
  t.after(() => gateway.stop())

  const validPath = `/stream/${config.gateway.token}/${HASH}/0/video.mkv`
  const ranged = await request({ port: address.port, pathname: validPath, headers: { range: 'bytes=2-5' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers['content-range'], 'bytes 2-5/10')
  assert.equal(ranged.body.toString(), '2345')

  const head = await request({ port: address.port, pathname: validPath, method: 'HEAD' })
  assert.equal(head.status, 206)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['accept-ranges'], 'bytes')

  const denied = await request({ port: address.port, pathname: `/stream/wrong/${HASH}/0/video.mkv` })
  assert.equal(denied.status, 404)
})

test('global cache janitor removes the oldest inactive torrent cache first', async (t) => {
  const { config, logger } = await createFixture(t)
  const oldHash = '1111111111111111111111111111111111111111'
  const recentHash = '2222222222222222222222222222222222222222'
  config.torrServer.cacheSizeBytes = 16
  config.torrServer.cacheInactiveGraceMs = 0

  const createCache = async (hash, date) => {
    const directory = path.join(config.paths.cache, hash)
    const file = path.join(directory, '0')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(file, Buffer.alloc(8))
    await fs.utimes(file, date, date)
    return directory
  }
  const oldDirectory = await createCache(oldHash, new Date('2026-01-01T00:00:00Z'))
  const activeDirectory = await createCache(HASH, new Date('2026-01-02T00:00:00Z'))
  const recentDirectory = await createCache(recentHash, new Date('2026-01-03T00:00:00Z'))
  const manager = { listTorrents: async () => [{ hash: HASH, stat: 3 }] }
  const janitor = new CacheJanitor(config, manager, logger)

  const result = await janitor.cleanup()
  assert.equal(result.beforeBytes, 24)
  assert.equal(result.afterBytes, 16)
  assert.deepEqual(result.removed, [{ hash: oldHash, bytes: 8 }])
  await assert.rejects(fs.access(oldDirectory))
  await fs.access(activeDirectory)
  await fs.access(recentDirectory)
})

test('global cache janitor never scans or removes cache during an active stream', async (t) => {
  const { config, logger } = await createFixture(t)
  let listed = false
  const manager = {
    listTorrents: async () => {
      listed = true
      return []
    }
  }
  const janitor = new CacheJanitor(config, manager, logger, () => true)

  const result = await janitor.cleanup()

  assert.deepEqual(result, { skipped: true, reason: 'active-stream', removed: [] })
  assert.equal(listed, false)
})

test('gateway records a stalled stream with peer and speed diagnostics', async (t) => {
  const media = Buffer.from('diagnostic-stream')
  const upstream = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(206, {
        'content-type': 'video/x-matroska',
        'content-range': `bytes 0-${media.length - 1}/${media.length}`,
        'content-length': media.length
      })
      res.end(media)
    }, 350)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => upstream.close(resolve)))

  const { config, stateStore } = await createFixture(t)
  config.torrServer.apiUrl = `http://127.0.0.1:${upstream.address().port}`
  config.gateway.stallWarningMs = 100
  stateStore.data.imports[HASH] = { hash: HASH, files: [{ index: 0, relativeOutput: 'movie.strm' }] }
  const events = []
  const logger = {
    info: async (message, details) => events.push({ level: 'info', message, details }),
    warn: async (message, details) => events.push({ level: 'warn', message, details }),
    error: async (message, details) => events.push({ level: 'error', message, details })
  }
  const manager = {
    getTorrent: async () => ({
      hash: HASH,
      stat_string: 'Torrent working',
      download_speed: 1024,
      active_peers: 2,
      connected_seeders: 1
    })
  }
  const gateway = new StreamGateway(config, stateStore, logger, manager)
  const address = await gateway.start()
  t.after(() => gateway.stop())

  const validPath = `/stream/${config.gateway.token}/${HASH}/0/video.mkv`
  const response = await request({ port: address.port, pathname: validPath, headers: { range: `bytes=0-${media.length - 1}` } })
  assert.equal(response.status, 206)
  assert.equal(response.body.toString(), media.toString())
  assert.equal(events.some((event) => event.message === 'Torrent stream stalled' && event.details.activePeers === 2), true)
  assert.equal(events.some((event) => event.message === 'Torrent stream finished' && event.details.outcome === 'completed'), true)
})
