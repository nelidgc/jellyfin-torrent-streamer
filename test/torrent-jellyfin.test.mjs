import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import {
  Logger,
  InboxWatcher,
  StateStore,
  StreamGateway,
  TorrentImporter,
  TorrServerManager,
  buildStreamUrl,
  deriveSeriesTitle,
  ensureDirectories,
  loadConfig,
  parseContentRangeTotal,
  parseEpisode,
  pickDisplayTitle,
  planLibraryEntries,
  runDoctor,
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
      preloadPercent: 1,
      uploadRateLimit: null,
      downloadRateLimit: null,
      disableUpload: null
    },
    gateway: {
      bindAddress: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'http://192.168.1.50:8091',
      token: 'test-token-with-enough-entropy',
      upstreamTimeoutMs: 2000
    },
    watch: { scanIntervalMs: 1000, stableDelayMs: 0, peerCheckMs: 0 },
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
  assert.match(planned[0].target, /Медиатека Jellyfin[\\/]Фильмы для семьи[\\/]Проверочный фильм 2026[\\/]Фильм с пробелами\.strm$/)
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
  assert.match(series[0].target, /TV Shows[\\/]Example Show[\\/]Season 01[\\/]Example\.Show\.S01E01\.strm$/)
  assert.match(series[1].target, /TV Shows[\\/]Example Show[\\/]Extras[\\/]Behind the scenes\.strm$/)
  assert.equal(series.length, 2)
  assert.equal(series[0].url, buildStreamUrl(config, HASH, 0, 'Example.Show.S01E01.mkv'))

  const movie = planLibraryEntries({
    hash: HASH,
    title: 'Example.Movie.2026',
    name: 'Example.Movie.2026',
    files: [{ index: 4, path: 'Example.Movie.2026/Example.Movie.2026.mkv', length: 500 }]
  }, 'movie.torrent', config)
  assert.match(movie[0].target, /Movies[\\/]Example Movie 2026[\\/]Example\.Movie\.2026\.strm$/)
  assert.equal(deriveSeriesTitle('Another.Show.S03.2160p'), 'Another Show')
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
  const updated = await importer.rebuildRecord(oldRecord)

  assert.match(updated.files[0].relativeOutput, /^tv[\\/]Moved Show[\\/]Season 02[\\/]/)
  assert.equal(await fs.readFile(path.join(config.paths.library, updated.files[0].relativeOutput), 'utf8'), `${buildStreamUrl(config, HASH, 0, status.files[0].path)}${os.EOL}`)
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
  assert.equal(configuredSettings.DisableUPNP, true)
  await assert.rejects(manager.request('/mock-error'), /HTTP 500: mock failure/)
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

  // A HEAD describes the whole resource. The one-byte range is only a probe, so its 206 and its
  // content-length of 1 must not be what the client is told.
  const head = await request({ port: address.port, pathname: validPath, method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], String(media.length))
  assert.equal(head.headers['content-range'], undefined)
  assert.equal(head.body.length, 0)
  assert.equal(head.headers['accept-ranges'], 'bytes')

  const denied = await request({ port: address.port, pathname: `/stream/wrong/${HASH}/0/video.mkv` })
  assert.equal(denied.status, 404)
})

test('library naming survives a transliterated name on either side', async (t) => {
  const { config } = await createFixture(t)
  config.library.moviesFolder = 'movies'

  // The .torrent file name is Latin, the release inside is not.
  const fromMetadata = planLibraryEntries({
    hash: HASH,
    title: '[rutor.is]CHerepashki-nindzya.2014_M.Foks_U.Fihtner.avi',
    name: 'Черепашки-ниндзя.2014 (М.Фокс, У.Фихтнер).avi',
    files: [{ index: 1, path: 'Черепашки-ниндзя.2014 (М.Фокс, У.Фихтнер).avi', length: 10 }]
  }, '[rutor.is]CHerepashki-nindzya.2014.torrent', config)
  assert.match(fromMetadata[0].relativeOutput.split(path.sep)[1], /Черепашки-ниндзя/)

  // ...and the mirror image, where the metadata is the transliterated side.
  const fromTitle = planLibraryEntries({
    hash: HASH,
    title: '[GTorrent.cc]_Черепашки-ниндзя',
    name: 'Cherepashki.Ninz9.2014.D.WEB-DLRip.1400MB.avi',
    files: [{ index: 0, path: 'Cherepashki.Ninz9.2014.D.WEB-DLRip.1400MB.avi', length: 10 }]
  }, '[GTorrent.cc]_Черепашки-ниндзя.torrent', config)
  assert.match(fromTitle[0].relativeOutput.split(path.sep)[1], /Черепашки-ниндзя/)

  // With no signal on either side the torrent's own metadata wins: the .torrent file was named
  // "cherepashki.nindzya.3.1990.DVDRip" while the release carries a title Jellyfin can match.
  assert.equal(
    pickDisplayTitle({
      hash: HASH,
      title: 'cherepashki.nindzya.3.1990.DVDRip.1861698',
      name: 'Teenage.Mutant.Ninja.Turtles.1990.Fullscreen.DVDRip.mkv'
    }, 'x.torrent'),
    'Teenage.Mutant.Ninja.Turtles.1990.Fullscreen.DVDRip'
  )
  assert.equal(pickDisplayTitle({ hash: HASH, title: 'Название А', name: 'Название Б' }, 'x.torrent'), 'Название Б')
  assert.equal(pickDisplayTitle({ hash: HASH, name: HASH, title: 'Real Title 2019' }, 'x.torrent'), 'Real Title 2019')
  assert.equal(pickDisplayTitle({ hash: HASH, name: '', title: '' }, 'From.File.torrent'), 'From.File')
})

test('a client that walks away is not a gateway warning', async (t) => {
  const { config, stateStore } = await createFixture(t)
  const warnings = []
  const logger = {
    info: () => Promise.resolve(),
    warn: (message) => { warnings.push(message); return Promise.resolve() },
    error: () => Promise.resolve()
  }
  const gateway = new StreamGateway(config, stateStore, logger)
  await gateway.start()
  t.after(() => gateway.stop())

  const fakeSocket = (writable) => ({
    writable,
    ended: false,
    destroyed: false,
    end() { this.ended = true },
    destroy() { this.destroyed = true }
  })

  // What every Jellyfin seek produces once ffmpeg is killed.
  const reset = fakeSocket(true)
  gateway.server.emit('clientError', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), reset)
  assert.equal(warnings.length, 0, 'a reset connection must not be logged as a problem')
  assert.equal(reset.destroyed, true)
  assert.equal(reset.ended, false, 'nothing should be written into a socket the peer dropped')

  // A socket that died between the error and the handler must not be written to either.
  const gone = fakeSocket(false)
  gateway.server.emit('clientError', Object.assign(new Error('parse error'), { code: 'HPE_INVALID_METHOD' }), gone)
  assert.equal(gone.destroyed, true)
  assert.equal(warnings.length, 0)

  // A genuine protocol error on a live socket still earns both a warning and a 400.
  const malformed = fakeSocket(true)
  gateway.server.emit('clientError', Object.assign(new Error('parse error'), { code: 'HPE_INVALID_METHOD' }), malformed)
  assert.equal(warnings.length, 1)
  assert.equal(malformed.ended, true)
})

test('HEAD reports the whole file, not the probe byte', async (t) => {
  const media = Buffer.from('0123456789')
  const upstream = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '')
    const start = Number(match[1])
    const end = match[2] ? Number(match[2]) : media.length - 1
    const body = media.subarray(start, end + 1)
    res.writeHead(206, {
      'content-type': 'video/x-matroska',
      'content-range': `bytes ${start}-${end}/${media.length}`,
      'content-length': body.length
    })
    res.end(body)
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => upstream.close(resolve)))

  const { config, stateStore, logger } = await createFixture(t)
  config.torrServer.apiUrl = `http://127.0.0.1:${upstream.address().port}`
  stateStore.data.imports[HASH] = { hash: HASH, files: [{ index: 0, relativeOutput: 'movie.strm' }] }
  const gateway = new StreamGateway(config, stateStore, logger)
  const address = await gateway.start()
  t.after(() => gateway.stop())

  const head = await request({
    port: address.port,
    pathname: `/stream/${config.gateway.token}/${HASH}/0/video.mkv`,
    method: 'HEAD'
  })
  assert.equal(head.status, 200, 'a HEAD must not come back as 206')
  assert.equal(head.headers['content-length'], String(media.length), 'the probe byte must not become the file size')
  assert.equal(head.headers['content-range'], undefined)
  assert.equal(head.headers['accept-ranges'], 'bytes')

  assert.equal(parseContentRangeTotal('bytes 0-0/12345'), 12345)
  assert.equal(parseContentRangeTotal('bytes */500'), 500)
  assert.equal(parseContentRangeTotal('items 0-0/5'), null)
  assert.equal(parseContentRangeTotal(undefined), null)
})

test('a HEAD probe without Content-Range does not advertise the probe length', async (t) => {
  const upstream = http.createServer((req, res) => {
    // A TorrServer build that answers a range request with 206 but no Content-Range at all.
    res.writeHead(206, { 'content-type': 'video/x-matroska', 'content-length': 1 })
    res.end('0')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => upstream.close(resolve)))

  const { config, stateStore, logger } = await createFixture(t)
  config.torrServer.apiUrl = `http://127.0.0.1:${upstream.address().port}`
  stateStore.data.imports[HASH] = { hash: HASH, files: [{ index: 0, relativeOutput: 'movie.strm' }] }
  const gateway = new StreamGateway(config, stateStore, logger)
  const address = await gateway.start()
  t.after(() => gateway.stop())

  const head = await request({
    port: address.port,
    pathname: `/stream/${config.gateway.token}/${HASH}/0/video.mkv`,
    method: 'HEAD'
  })
  assert.equal(head.status, 200)
  assert.equal(head.headers['content-length'], undefined, 'better no length than a 1-byte lie')
})

test('TorrServer settings are written only when they actually differ', async (t) => {
  let written = null
  let setCalls = 0
  const settings = {
    CacheSize: 21474836480,
    UseDisk: true,
    RemoveCacheOnDrop: false,
    PreloadCache: 1,
    DisableUPNP: true,
    UploadRateLimit: 0,
    DownloadRateLimit: 0,
    DisableUpload: false
  }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      if (body.action === 'get') res.end(JSON.stringify(settings))
      else {
        setCalls += 1
        written = body.sets
        res.end('{}')
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const { config, logger } = await createFixture(t)
  config.torrServer.apiUrl = `http://127.0.0.1:${server.address().port}`
  settings.TorrentsSavePath = config.paths.cache
  const manager = new TorrServerManager(config, logger)

  await manager.configure()
  assert.equal(setCalls, 0, 'a TorrServer that already matches must be left alone')

  config.torrServer.uploadRateLimit = 512
  config.torrServer.disableUpload = true
  await manager.configure()
  assert.equal(setCalls, 1)
  assert.equal(written.UploadRateLimit, 512)
  assert.equal(written.DisableUpload, true)
  assert.equal(written.DownloadRateLimit, 0, 'a null knob keeps whatever TorrServer had')
})

test('an import with no peers is kept but reported instead of failing', async (t) => {
  const { config, stateStore, logger } = await createFixture(t)
  config.watch.peerCheckMs = 50
  const warnings = []
  const recorder = {
    info: () => Promise.resolve(),
    warn: (message) => { warnings.push(message); return Promise.resolve() },
    error: () => Promise.resolve()
  }
  const status = {
    hash: HASH,
    title: 'Lonely.Movie.2019',
    name: 'Lonely.Movie.2019',
    files: [{ index: 0, path: 'Lonely.Movie.2019/movie.mkv', length: 10 }],
    active_peers: 0,
    total_peers: 0
  }
  const manager = { uploadTorrent: async () => status, getTorrent: async () => status }
  manager.waitForPeers = TorrServerManager.prototype.waitForPeers.bind(manager)
  const importer = new TorrentImporter(config, manager, stateStore, logger)
  importer.logger = recorder

  const input = path.join(config.paths.inbox, 'lonely.torrent')
  await fs.writeFile(input, 'torrent-fixture')
  const record = await importer.importCore(input)

  assert.equal(record.hash, HASH, 'the import still succeeds')
  assert.ok(await fs.readFile(path.resolve(config.paths.library, record.files[0].relativeOutput), 'utf8'))
  assert.match(warnings.at(-1), /no peers/)

  assert.equal(TorrServerManager.countPeers({ active_peers: 0, connected_seeders: 3 }), 3)
  assert.equal(TorrServerManager.countPeers({ ConnectedSeeders: 2 }), 2)
  assert.equal(TorrServerManager.countPeers({}), null, 'a build reporting no counters must not look dead')
})

test('doctor measures the cache on disk and warns when it overshoots its target', async (t) => {
  const { config, stateStore, logger } = await createFixture(t)
  config.torrServer.cacheSizeBytes = 1024
  await fs.writeFile(path.join(config.paths.cache, 'piece.bin'), Buffer.alloc(4096))
  const manager = {
    ensureStarted: async () => true,
    configure: async () => {},
    request: async () => ({
      CacheSize: config.torrServer.cacheSizeBytes,
      UseDisk: true,
      TorrentsSavePath: config.paths.cache
    })
  }

  const printed = []
  const originalLog = console.log
  console.log = (line) => printed.push(String(line))
  try {
    await runDoctor(config, manager, stateStore, logger)
  } finally {
    console.log = originalLog
  }

  const cacheLine = printed.find((line) => line.includes('Cache size on disk'))
  assert.ok(cacheLine, `doctor did not report the cache size: ${printed.join(' | ')}`)
  assert.match(cacheLine, /^\[WARN]/, 'an oversized cache is a warning, not a failure')
  assert.match(cacheLine, /4096 bytes in 1 file/)
})
