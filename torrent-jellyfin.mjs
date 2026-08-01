#!/usr/bin/env node

import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const STATE_FILE_NAME = 'imports.json'
const TORRSERVER_STATE_DIR = 'torrserver'
const VIDEO_ID_RE = /^\d+$/
const HASH_RE = /^[a-f0-9]{40,64}$/i
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const FORWARDED_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified'
])

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function timestamp() {
  return new Date().toISOString()
}

function stripBom(value) {
  return value.replace(/^\uFEFF/, '')
}

function ensureTrailingSlashRemoved(value) {
  return value.replace(/\/+$/, '')
}

function resolveFrom(baseDirectory, value) {
  if (!value || typeof value !== 'string') {
    throw new Error('Expected a non-empty path in configuration')
  }
  return path.resolve(baseDirectory, value)
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function safePath(root, segments) {
  const candidate = path.resolve(root, ...segments)
  if (!isPathInside(root, candidate)) {
    throw new Error(`Unsafe output path: ${candidate}`)
  }
  return candidate
}

function toInteger(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`)
  }
  return value
}

function toOptionalInteger(value, name, minimum = 0) {
  if (value === null || value === undefined) return null
  const normalized = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value
  return toInteger(normalized, name, minimum)
}

export async function loadConfig(configFile = path.join(SCRIPT_DIR, 'config.json')) {
  const absoluteConfigPath = path.resolve(configFile)
  let parsed
  try {
    parsed = JSON.parse(stripBom(await fs.readFile(absoluteConfigPath, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Configuration not found: ${absoluteConfigPath}. Run install.ps1 or copy config.example.json.`)
    }
    throw new Error(`Cannot read configuration ${absoluteConfigPath}: ${error.message}`)
  }

  const baseDirectory = path.dirname(absoluteConfigPath)
  const requiredPathNames = ['inbox', 'processed', 'failed', 'library', 'state', 'cache', 'logs']
  for (const name of requiredPathNames) {
    if (!parsed.paths?.[name]) throw new Error(`Missing paths.${name} in configuration`)
    parsed.paths[name] = resolveFrom(baseDirectory, parsed.paths[name])
  }
  parsed.torrServer ??= {}
  parsed.gateway ??= {}
  parsed.watch ??= {}
  parsed.library ??= {}
  parsed.torrServer.executable = resolveFrom(baseDirectory, parsed.torrServer.executable)
  parsed.torrServer.apiUrl = ensureTrailingSlashRemoved(parsed.torrServer.apiUrl || 'http://127.0.0.1:8090')
  parsed.torrServer.bindAddress ||= '127.0.0.1'
  parsed.torrServer.peerBindAddress = String(parsed.torrServer.peerBindAddress || '').trim()
  if (parsed.torrServer.peerBindAddress && !/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(parsed.torrServer.peerBindAddress)) {
    throw new Error('torrServer.peerBindAddress must use IPv4:port format, for example 192.168.1.10:0')
  }
  parsed.torrServer.port = toInteger(parsed.torrServer.port ?? 8090, 'torrServer.port', 1)
  parsed.torrServer.startupTimeoutMs = toInteger(parsed.torrServer.startupTimeoutMs ?? 30000, 'torrServer.startupTimeoutMs', 1000)
  parsed.torrServer.requestTimeoutMs = toInteger(parsed.torrServer.requestTimeoutMs ?? 120000, 'torrServer.requestTimeoutMs', 1000)
  parsed.torrServer.cacheSizeBytes = toInteger(parsed.torrServer.cacheSizeBytes ?? 21474836480, 'torrServer.cacheSizeBytes', 1048576)
  parsed.torrServer.cacheCleanupIntervalMs = toInteger(parsed.torrServer.cacheCleanupIntervalMs ?? 300000, 'torrServer.cacheCleanupIntervalMs', 10000)
  parsed.torrServer.cacheInactiveGraceMs = toInteger(parsed.torrServer.cacheInactiveGraceMs ?? 60000, 'torrServer.cacheInactiveGraceMs', 0)
  parsed.torrServer.connectionsLimit = toInteger(parsed.torrServer.connectionsLimit ?? 100, 'torrServer.connectionsLimit', 5)
  if (parsed.torrServer.connectionsLimit > 500) throw new Error('torrServer.connectionsLimit must not exceed 500')
  parsed.torrServer.readerReadAheadPercent = toInteger(parsed.torrServer.readerReadAheadPercent ?? 100, 'torrServer.readerReadAheadPercent', 5)
  if (parsed.torrServer.readerReadAheadPercent > 100) throw new Error('torrServer.readerReadAheadPercent must not exceed 100')
  parsed.torrServer.preloadPercent = toInteger(parsed.torrServer.preloadPercent ?? 1, 'torrServer.preloadPercent', 0)
  if (parsed.torrServer.preloadPercent > 100) throw new Error('torrServer.preloadPercent must not exceed 100')
  parsed.torrServer.metadataWarmupBytes = toInteger(
    parsed.torrServer.metadataWarmupBytes ?? 4194304,
    'torrServer.metadataWarmupBytes',
    0
  )
  if (parsed.torrServer.metadataWarmupBytes > 67108864) {
    throw new Error('torrServer.metadataWarmupBytes must not exceed 67108864')
  }
  parsed.torrServer.metadataWarmupRecentTorrents = toInteger(
    parsed.torrServer.metadataWarmupRecentTorrents ?? 0,
    'torrServer.metadataWarmupRecentTorrents',
    0
  )
  if (parsed.torrServer.metadataWarmupRecentTorrents > 20) {
    throw new Error('torrServer.metadataWarmupRecentTorrents must not exceed 20')
  }
  parsed.torrServer.metadataWarmupTimeoutMs = toInteger(
    parsed.torrServer.metadataWarmupTimeoutMs ?? 120000,
    'torrServer.metadataWarmupTimeoutMs',
    5000
  )
  parsed.torrServer.torrentDisconnectTimeoutSeconds = toInteger(
    parsed.torrServer.torrentDisconnectTimeoutSeconds ?? 600,
    'torrServer.torrentDisconnectTimeoutSeconds',
    30
  )
  if (parsed.torrServer.torrentDisconnectTimeoutSeconds > 3600) {
    throw new Error('torrServer.torrentDisconnectTimeoutSeconds must not exceed 3600')
  }
  parsed.torrServer.uploadRateLimit = toOptionalInteger(
    parsed.torrServer.uploadRateLimit ?? null,
    'torrServer.uploadRateLimit'
  )
  parsed.torrServer.downloadRateLimit = toOptionalInteger(
    parsed.torrServer.downloadRateLimit ?? null,
    'torrServer.downloadRateLimit'
  )
  parsed.torrServer.disableUpload ??= null
  if (parsed.torrServer.disableUpload !== null && typeof parsed.torrServer.disableUpload !== 'boolean') {
    throw new Error('torrServer.disableUpload must be true, false, or null')
  }
  parsed.torrServer.manageProcess = parsed.torrServer.manageProcess !== false

  parsed.gateway.bindAddress ||= '0.0.0.0'
  parsed.gateway.port = toInteger(parsed.gateway.port ?? 8091, 'gateway.port', 0)
  parsed.gateway.publicBaseUrl = ensureTrailingSlashRemoved(parsed.gateway.publicBaseUrl || 'http://127.0.0.1:8091')
  parsed.gateway.upstreamTimeoutMs = toInteger(parsed.gateway.upstreamTimeoutMs ?? 120000, 'gateway.upstreamTimeoutMs', 1000)
  parsed.gateway.stallWarningMs = toInteger(parsed.gateway.stallWarningMs ?? 15000, 'gateway.stallWarningMs', 5000)
  if (parsed.gateway.stallWarningMs >= parsed.gateway.upstreamTimeoutMs) {
    throw new Error('gateway.stallWarningMs must be less than gateway.upstreamTimeoutMs')
  }
  if (!parsed.gateway.token || parsed.gateway.token === 'CHANGE_ME') {
    throw new Error('gateway.token is not configured. Run install.ps1 or set a long random token in config.json.')
  }
  try {
    const publicUrl = new URL(parsed.gateway.publicBaseUrl)
    if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('unsupported protocol')
  } catch (error) {
    throw new Error(`Invalid gateway.publicBaseUrl: ${error.message}`)
  }

  parsed.watch.scanIntervalMs = toInteger(parsed.watch.scanIntervalMs ?? 10000, 'watch.scanIntervalMs', 250)
  parsed.watch.stableDelayMs = toInteger(parsed.watch.stableDelayMs ?? 2000, 'watch.stableDelayMs', 0)
  parsed.watch.peerCheckMs = toInteger(parsed.watch.peerCheckMs ?? 10000, 'watch.peerCheckMs', 0)
  parsed.library.moviesFolder ||= 'Movies'
  parsed.library.showsFolder ||= 'TV Shows'
  parsed.library.extrasFolder ||= 'Extras'
  parsed.library.titlePreference ||= 'metadata'
  if (!['metadata', 'localized'].includes(parsed.library.titlePreference)) {
    throw new Error('library.titlePreference must be metadata or localized')
  }
  if (!Array.isArray(parsed.library.videoExtensions) || parsed.library.videoExtensions.length === 0) {
    throw new Error('library.videoExtensions must contain at least one extension')
  }
  parsed.library.videoExtensions = parsed.library.videoExtensions.map((extension) => {
    const normalized = String(extension).toLowerCase()
    return normalized.startsWith('.') ? normalized : `.${normalized}`
  })
  parsed.configFile = absoluteConfigPath
  return parsed
}

export async function ensureDirectories(config) {
  const directories = [
    ...Object.values(config.paths),
    path.dirname(config.torrServer.executable),
    path.join(config.paths.state, TORRSERVER_STATE_DIR)
  ]
  await Promise.all(directories.map((directory) => fs.mkdir(directory, { recursive: true })))
}

export class Logger {
  constructor(logDirectory, { silent = false } = {}) {
    this.logDirectory = logDirectory
    this.silent = silent
    this.logFile = logDirectory ? path.join(logDirectory, 'torrent-jellyfin.log') : null
  }

  async write(level, message, details) {
    const suffix = details === undefined
      ? ''
      : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`
    const line = `${timestamp()} ${level.toUpperCase()} ${message}${suffix}`
    if (!this.silent) {
      const output = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      output(line)
    }
    if (this.logFile) {
      await fs.mkdir(this.logDirectory, { recursive: true })
      await fs.appendFile(this.logFile, `${line}${os.EOL}`, 'utf8').catch(() => {})
    }
  }

  info(message, details) { return this.write('info', message, details) }
  warn(message, details) { return this.write('warn', message, details) }
  error(message, details) { return this.write('error', message, details) }
}

export class StateStore {
  constructor(stateDirectory) {
    this.file = path.join(stateDirectory, STATE_FILE_NAME)
    this.data = { version: 1, imports: {} }
  }

  async load() {
    try {
      const loaded = JSON.parse(stripBom(await fs.readFile(this.file, 'utf8')))
      if (loaded.version !== 1 || !loaded.imports || typeof loaded.imports !== 'object') {
        throw new Error('unsupported state format')
      }
      this.data = loaded
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot load state file: ${error.message}`)
    }
    return this.data
  }

  get(hash) {
    return this.data.imports[String(hash).toLowerCase()] || null
  }

  list() {
    return Object.values(this.data.imports)
  }

  isAllowed(hash, fileIndex) {
    const record = this.get(hash)
    return Boolean(record?.files?.some((file) => Number(file.index) === Number(fileIndex)))
  }

  async put(record) {
    const key = record.hash.toLowerCase()
    const previous = this.data.imports[key]
    this.data.imports[key] = record
    try {
      await this.save()
    } catch (error) {
      if (previous) this.data.imports[key] = previous
      else delete this.data.imports[key]
      throw error
    }
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`
    await fs.writeFile(temporary, `${JSON.stringify(this.data, null, 2)}${os.EOL}`, { encoding: 'utf8', flag: 'wx' })
    try {
      await fs.rename(temporary, this.file)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
}

function withTimeout(milliseconds, message) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(message)), milliseconds)
  timer.unref?.()
  return { controller, clear: () => clearTimeout(timer) }
}

async function parseApiResponse(response) {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`TorrServer HTTP ${response.status}: ${text.slice(0, 500)}`)
  }
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function normalizeTorrentStatus(status) {
  if (!status || typeof status !== 'object') throw new Error('TorrServer returned an invalid torrent status')
  const hash = String(status.hash ?? status.Hash ?? '').toLowerCase()
  if (!HASH_RE.test(hash)) throw new Error('TorrServer response does not contain a valid infohash')
  const rawFiles = status.file_stats ?? status.fileStats ?? status.FileStats ?? []
  const files = rawFiles.map((file, fallbackIndex) => ({
    index: Number(file.id ?? file.index ?? file.Id ?? fallbackIndex),
    path: String(file.path ?? file.Path ?? file.name ?? file.Name ?? ''),
    length: Number(file.length ?? file.Length ?? file.size ?? file.Size ?? 0)
  }))
  return {
    ...status,
    hash,
    name: String(status.name ?? status.Name ?? status.title ?? status.Title ?? hash),
    title: String(status.title ?? status.Title ?? status.name ?? status.Name ?? hash),
    files
  }
}

function settingValuesEqual(name, current, desired) {
  if (name === 'TorrentsSavePath') {
    try {
      const left = path.resolve(String(current))
      const right = path.resolve(String(desired))
      return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
    } catch {
      return false
    }
  }
  return current === desired
}

export class TorrServerManager {
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.child = null
    this.stopping = false
    this.restartTimer = null
    this.logStream = null
    this.spawnError = null
  }

  async request(endpoint, { method = 'GET', body, timeoutMs } = {}) {
    const timeout = withTimeout(
      timeoutMs ?? this.config.torrServer.requestTimeoutMs,
      `TorrServer request timed out: ${endpoint}`
    )
    try {
      const response = await fetch(`${this.config.torrServer.apiUrl}${endpoint}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        signal: timeout.controller.signal
      })
      return await parseApiResponse(response)
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`TorrServer request timed out: ${endpoint}`)
      throw error
    } finally {
      timeout.clear()
    }
  }

  async health() {
    try {
      await this.request('/echo', { timeoutMs: 2000 })
      return true
    } catch {
      return false
    }
  }

  async portIsOpen() {
    const apiUrl = new URL(this.config.torrServer.apiUrl)
    const port = Number(apiUrl.port || 80)
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: apiUrl.hostname, port })
      let settled = false
      const finish = (open) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(open)
      }
      socket.setTimeout(500, () => finish(false))
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    })
  }

  async ensureStarted() {
    if (await this.health()) return false
    if (!this.config.torrServer.manageProcess) {
      throw new Error(`TorrServer is unavailable at ${this.config.torrServer.apiUrl}`)
    }
    await fs.access(this.config.torrServer.executable, fsSync.constants.X_OK).catch(() => {
      throw new Error(`TorrServer executable not found: ${this.config.torrServer.executable}. Run install.ps1.`)
    })
    let startedProcess = false
    if (await this.portIsOpen()) {
      await this.logger.info('TorrServer port is open; waiting for API', { url: this.config.torrServer.apiUrl })
    } else if (!this.child) {
      this.startProcess()
      startedProcess = true
    }
    const deadline = Date.now() + this.config.torrServer.startupTimeoutMs
    while (Date.now() < deadline) {
      if (await this.health()) {
        await this.logger.info('TorrServer is ready', { url: this.config.torrServer.apiUrl })
        return startedProcess
      }
      if (this.spawnError) throw new Error(`Cannot start TorrServer: ${this.spawnError.message}`)
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) break
      if (!this.child && !(await this.portIsOpen())) {
        this.startProcess()
        startedProcess = true
      }
      await sleep(300)
    }
    throw new Error(`TorrServer did not become ready within ${this.config.torrServer.startupTimeoutMs} ms`)
  }

  startProcess() {
    if (this.child || this.stopping) return
    this.spawnError = null
    const statePath = path.join(this.config.paths.state, TORRSERVER_STATE_DIR)
    fsSync.mkdirSync(statePath, { recursive: true })
    fsSync.mkdirSync(this.config.paths.logs, { recursive: true })
    this.logStream ??= fsSync.createWriteStream(path.join(this.config.paths.logs, 'torrserver.log'), { flags: 'a' })
    const args = [
      '--ip', this.config.torrServer.bindAddress,
      '--port', String(this.config.torrServer.port),
      '--path', statePath
    ]
    if (this.config.torrServer.peerBindAddress) {
      args.push('--torrentaddr', this.config.torrServer.peerBindAddress)
    }
    const child = spawn(this.config.torrServer.executable, args, {
      cwd: path.dirname(this.config.torrServer.executable),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout.pipe(this.logStream, { end: false })
    child.stderr.pipe(this.logStream, { end: false })
    child.once('error', (error) => {
      if (this.child === child) this.child = null
      this.spawnError = error
      this.logger.error('TorrServer process error', error.message)
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      this.logger.warn('TorrServer exited', { code, signal })
      if (!this.stopping) {
        clearTimeout(this.restartTimer)
        this.restartTimer = setTimeout(() => {
          this.ensureStarted().catch((error) => this.logger.error('Cannot restart TorrServer', error.message))
        }, 2000)
        this.restartTimer.unref?.()
      }
    })
  }

  async configure() {
    const current = await this.request('/settings', { method: 'POST', body: { action: 'get' } })
    if (!current || typeof current !== 'object') throw new Error('Cannot read TorrServer settings')
    const desired = {
      CacheSize: this.config.torrServer.cacheSizeBytes,
      UseDisk: true,
      TorrentsSavePath: this.config.paths.cache,
      RemoveCacheOnDrop: false,
      PreloadCache: this.config.torrServer.preloadPercent,
      ConnectionsLimit: this.config.torrServer.connectionsLimit,
      ReaderReadAHead: this.config.torrServer.readerReadAheadPercent,
      TorrentDisconnectTimeout: this.config.torrServer.torrentDisconnectTimeoutSeconds,
      DisableUPNP: true
    }
    if (this.config.torrServer.uploadRateLimit !== null) {
      desired.UploadRateLimit = this.config.torrServer.uploadRateLimit
    }
    if (this.config.torrServer.downloadRateLimit !== null) {
      desired.DownloadRateLimit = this.config.torrServer.downloadRateLimit
    }
    if (this.config.torrServer.disableUpload !== null) {
      desired.DisableUpload = this.config.torrServer.disableUpload
    }
    const changed = Object.keys(desired).filter((name) => !settingValuesEqual(name, current[name], desired[name]))
    if (changed.length === 0) {
      await this.logger.info('TorrServer settings already match the configuration')
      return current
    }
    const updated = { ...current, ...desired }
    await this.request('/settings', { method: 'POST', body: { action: 'set', sets: updated } })
    await this.logger.info('TorrServer cache configured', {
      changed,
      bytes: updated.CacheSize,
      path: updated.TorrentsSavePath,
      preloadPercent: updated.PreloadCache,
      connectionsLimit: updated.ConnectionsLimit,
      readerReadAheadPercent: updated.ReaderReadAHead,
      torrentDisconnectTimeoutSeconds: updated.TorrentDisconnectTimeout,
      uploadRateLimit: updated.UploadRateLimit,
      downloadRateLimit: updated.DownloadRateLimit,
      disableUpload: updated.DisableUpload,
      disableUpnp: updated.DisableUPNP,
      peerBindAddress: this.config.torrServer.peerBindAddress || 'system routing'
    })
    return updated
  }

  async uploadTorrent(filePath, title = path.basename(filePath, path.extname(filePath))) {
    const timeout = withTimeout(this.config.torrServer.requestTimeoutMs, `Torrent upload timed out: ${filePath}`)
    try {
      const form = new FormData()
      form.append('file', new Blob([await fs.readFile(filePath)]), path.basename(filePath))
      form.append('save', 'true')
      form.append('title', title)
      const response = await fetch(`${this.config.torrServer.apiUrl}/torrent/upload`, {
        method: 'POST',
        body: form,
        signal: timeout.controller.signal
      })
      return normalizeTorrentStatus(await parseApiResponse(response))
    } finally {
      timeout.clear()
    }
  }

  async getTorrent(hash) {
    try {
      const result = await this.request('/torrents', {
        method: 'POST',
        body: { action: 'get', hash: String(hash).toLowerCase() }
      })
      const resultHash = result?.hash ?? result?.Hash
      if (!result || typeof result !== 'object' || !resultHash) return null
      return normalizeTorrentStatus(result)
    } catch (error) {
      if (/HTTP 404|not found/i.test(error.message)) return null
      throw error
    }
  }

  async listTorrents() {
    const result = await this.request('/torrents', { method: 'POST', body: { action: 'list' } })
    if (!Array.isArray(result)) return []
    return result.map(normalizeTorrentStatus)
  }

  async warmRange(hash, fileIndex, start, end, shouldContinue) {
    const timeout = withTimeout(
      this.config.torrServer.metadataWarmupTimeoutMs,
      `Metadata warmup timed out: ${hash}/${fileIndex}`
    )
    const cancelTimer = setInterval(() => {
      if (!shouldContinue()) timeout.controller.abort()
    }, 250)
    cancelTimer.unref?.()
    try {
      const response = await fetch(`${this.config.torrServer.apiUrl}/play/${hash}/${fileIndex}`, {
        headers: { range: `bytes=${start}-${end}` },
        signal: timeout.controller.signal
      })
      if (![200, 206].includes(response.status)) {
        throw new Error(`Metadata warmup HTTP ${response.status}: ${hash}/${fileIndex}`)
      }
      let bytes = 0
      for await (const chunk of response.body) bytes += chunk.length
      return { bytes, canceled: false }
    } catch (error) {
      if (error.name === 'AbortError' && !shouldContinue()) return { bytes: 0, canceled: true }
      if (error.name === 'AbortError') throw new Error(`Metadata warmup timed out: ${hash}/${fileIndex}`)
      throw error
    } finally {
      clearInterval(cancelTimer)
      timeout.clear()
    }
  }

  async warmMetadata(record, shouldContinue = () => true) {
    const warmupBytes = this.config.torrServer.metadataWarmupBytes
    if (warmupBytes <= 0 || !record?.files?.length) return { bytes: 0, canceled: false }
    let bytes = 0
    for (const file of record.files) {
      if (!shouldContinue()) return { bytes, canceled: true }
      const length = Number(file.length)
      const fileIndex = Number(file.index)
      if (!Number.isSafeInteger(length) || length <= 0 || !Number.isInteger(fileIndex) || fileIndex < 0) continue
      const headEnd = Math.min(length, warmupBytes) - 1
      const tailStart = Math.max(headEnd + 1, length - warmupBytes)
      const ranges = [[0, headEnd]]
      if (tailStart < length) ranges.push([tailStart, length - 1])
      for (const [start, end] of ranges) {
        if (!shouldContinue()) return { bytes, canceled: true }
        const result = await this.warmRange(record.hash, fileIndex, start, end, shouldContinue)
        bytes += result.bytes
        if (result.canceled) return { bytes, canceled: true }
      }
    }
    return { bytes, canceled: false }
  }

  async waitForFiles(initialStatus, timeoutMs = 15000) {
    if (initialStatus.files.length > 0) return initialStatus
    const deadline = Date.now() + Math.min(timeoutMs, this.config.torrServer.requestTimeoutMs)
    while (Date.now() < deadline) {
      await sleep(250)
      const refreshed = await this.getTorrent(initialStatus.hash)
      if (refreshed?.files?.length) return refreshed
    }
    return initialStatus
  }

  async stop() {
    this.stopping = true
    clearTimeout(this.restartTimer)
    if (this.child) {
      const child = this.child
      child.kill()
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        sleep(5000)
      ])
      this.child = null
    }
    this.logStream?.end()
    this.logStream = null
  }
}

export class MetadataWarmup {
  constructor(config, manager, logger, isStreaming = () => false) {
    this.config = config
    this.manager = manager
    this.logger = logger
    this.isStreaming = isStreaming
    this.queue = []
    this.queuedHashes = new Set()
    this.running = null
    this.stopped = true
  }

  enqueue(record) {
    const hash = String(record?.hash || '').toLowerCase()
    if (this.stopped || !HASH_RE.test(hash) || this.queuedHashes.has(hash)) return
    this.queuedHashes.add(hash)
    this.queue.push(record)
    this.pump()
  }

  start(records = []) {
    this.stopped = false
    for (const record of records) this.enqueue(record)
  }

  pump() {
    if (this.running) return this.running
    this.running = this.run().finally(() => {
      this.running = null
      if (!this.stopped && this.queue.length > 0) this.pump()
    })
    return this.running
  }

  async run() {
    while (!this.stopped && this.queue.length > 0) {
      while (!this.stopped && this.isStreaming()) await sleep(500)
      if (this.stopped) break
      const record = this.queue.shift()
      this.queuedHashes.delete(String(record.hash).toLowerCase())
      try {
        const result = await this.manager.warmMetadata(record, () => !this.stopped && !this.isStreaming())
        if (result.canceled && !this.stopped) {
          this.enqueue(record)
          await sleep(1000)
        } else if (!result.canceled) {
          await this.logger.info('Torrent metadata warmed', {
            hash: record.hash,
            videos: record.files.length,
            bytes: result.bytes
          })
        }
      } catch (error) {
        await this.logger.warn('Torrent metadata warmup failed', { hash: record.hash, error: error.message })
      }
    }
  }

  async stop() {
    this.stopped = true
    await this.running?.catch(() => {})
  }
}

const PEER_COUNTER_NAMES = {
  activePeers: ['active_peers', 'activePeers', 'ActivePeers'],
  connectedSeeders: ['connected_seeders', 'connectedSeeders', 'ConnectedSeeders'],
  totalPeers: ['total_peers', 'totalPeers', 'TotalPeers']
}

function readCounter(status, names) {
  let best = null
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(status || {}, name)) continue
    const value = Number(status[name])
    if (Number.isFinite(value) && value >= 0) best = Math.max(best ?? 0, value)
  }
  return best
}

export function readPeerCounts(status) {
  return {
    activePeers: readCounter(status, PEER_COUNTER_NAMES.activePeers),
    connectedSeeders: readCounter(status, PEER_COUNTER_NAMES.connectedSeeders),
    totalPeers: readCounter(status, PEER_COUNTER_NAMES.totalPeers)
  }
}

export class PeerMonitor {
  constructor(config, manager, logger) {
    this.config = config
    this.manager = manager
    this.logger = logger
    this.jobs = new Map()
    this.warnedHashes = new Set()
    this.stopWaiters = new Set()
    this.stopped = true
  }

  start() {
    this.stopped = false
  }

  schedule(record) {
    const hash = String(record?.hash || '').toLowerCase()
    if (this.stopped || this.config.watch.peerCheckMs <= 0 || !HASH_RE.test(hash)) return null
    if (this.jobs.has(hash)) return this.jobs.get(hash)
    const job = this.check({ ...record, hash }).finally(() => this.jobs.delete(hash))
    this.jobs.set(hash, job)
    return job
  }

  async check(record) {
    const deadline = Date.now() + this.config.watch.peerCheckMs
    let lastCounts = null
    while (!this.stopped) {
      const status = await this.manager.getTorrent(record.hash).catch(() => null)
      if (status) {
        const counts = readPeerCounts(status)
        if (Object.values(counts).some((value) => value !== null)) lastCounts = counts
        if ((counts.activePeers ?? 0) > 0 || (counts.connectedSeeders ?? 0) > 0) return counts
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          this.stopWaiters.delete(finish)
          resolve()
        }
        const timer = setTimeout(finish, Math.min(1000, remaining))
        this.stopWaiters.add(finish)
      })
    }
    if (!this.stopped && lastCounts && !this.warnedHashes.has(record.hash)) {
      this.warnedHashes.add(record.hash)
      await this.logger.warn('Torrent has no connected peers yet; playback can stall until peers become available', {
        hash: record.hash,
        activePeers: lastCounts.activePeers ?? 0,
        connectedSeeders: lastCounts.connectedSeeders ?? 0,
        totalPeers: lastCounts.totalPeers
      })
    }
    return lastCounts
  }

  async drain() {
    await Promise.allSettled([...this.jobs.values()])
  }

  async stop() {
    this.stopped = true
    for (const wake of [...this.stopWaiters]) wake()
    await this.drain()
  }
}

async function inspectCacheDirectory(directory) {
  const queue = [directory]
  let bytes = 0
  let lastUsedMs = 0
  let files = 0
  while (queue.length > 0) {
    const current = queue.shift()
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const candidate = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        queue.push(candidate)
        continue
      }
      if (!entry.isFile()) continue
      const stat = await fs.stat(candidate)
      bytes += stat.size
      files += 1
      lastUsedMs = Math.max(lastUsedMs, stat.mtimeMs, stat.atimeMs)
    }
  }
  if (lastUsedMs === 0) {
    const stat = await fs.stat(directory)
    lastUsedMs = Math.max(stat.mtimeMs, stat.atimeMs)
  }
  return { bytes, files, lastUsedMs }
}

function torrentIsActive(status) {
  const value = Number(status?.stat ?? status?.Stat)
  return !Number.isFinite(value) || value !== 5
}

export class CacheJanitor {
  constructor(config, manager, logger, isStreaming = () => false) {
    this.config = config
    this.manager = manager
    this.logger = logger
    this.isStreaming = isStreaming
    this.interval = null
    this.running = null
  }

  async inspect() {
    const root = path.resolve(this.config.paths.cache)
    const entries = await fs.readdir(root, { withFileTypes: true })
    const directories = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !HASH_RE.test(entry.name)) continue
      const directory = safePath(root, [entry.name])
      const details = await inspectCacheDirectory(directory)
      directories.push({ hash: entry.name.toLowerCase(), directory, ...details })
    }
    return {
      root,
      bytes: directories.reduce((total, entry) => total + entry.bytes, 0),
      directories
    }
  }

  async cleanup({ logSummary = false } = {}) {
    if (this.isStreaming()) {
      if (logSummary) await this.logger.info('Cache cleanup skipped while streaming')
      return { skipped: true, reason: 'active-stream', removed: [] }
    }
    if (this.running) return this.running
    this.running = this.performCleanup({ logSummary }).finally(() => {
      this.running = null
    })
    return this.running
  }

  async performCleanup({ logSummary }) {
    const inspected = await this.inspect()
    const targetBytes = this.config.torrServer.cacheSizeBytes
    if (inspected.bytes <= targetBytes) {
      if (logSummary) {
        await this.logger.info('Cache usage checked', {
          bytes: inspected.bytes,
          targetBytes,
          directories: inspected.directories.length
        })
      }
      return { beforeBytes: inspected.bytes, afterBytes: inspected.bytes, removed: [] }
    }

    const torrents = await this.manager.listTorrents()
    const activeHashes = new Set(torrents.filter(torrentIsActive).map((torrent) => torrent.hash))
    const cutoff = Date.now() - this.config.torrServer.cacheInactiveGraceMs
    const candidates = inspected.directories
      .filter((entry) => !activeHashes.has(entry.hash) && entry.lastUsedMs <= cutoff)
      .sort((left, right) => left.lastUsedMs - right.lastUsedMs || left.hash.localeCompare(right.hash))

    let afterBytes = inspected.bytes
    const removed = []
    for (const candidate of candidates) {
      if (afterBytes <= targetBytes) break
      const resolved = path.resolve(candidate.directory)
      if (!isPathInside(inspected.root, resolved) || path.dirname(resolved) !== inspected.root || !HASH_RE.test(path.basename(resolved))) {
        await this.logger.error('Refusing unsafe cache removal', { directory: resolved })
        continue
      }
      try {
        await fs.rm(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
        afterBytes = Math.max(0, afterBytes - candidate.bytes)
        removed.push({ hash: candidate.hash, bytes: candidate.bytes })
      } catch (error) {
        await this.logger.warn('Cannot remove inactive cache directory', {
          hash: candidate.hash,
          error: error.message
        })
      }
    }

    const details = {
      beforeBytes: inspected.bytes,
      afterBytes,
      targetBytes,
      activeDirectories: activeHashes.size,
      removed
    }
    if (afterBytes > targetBytes) await this.logger.warn('Cache remains above target', details)
    else await this.logger.info('Cache cleanup completed', details)
    return details
  }

  async start() {
    await this.cleanup({ logSummary: true })
    this.interval = setInterval(() => {
      this.cleanup().catch((error) => this.logger.error('Cache cleanup failed', error.message))
    }, this.config.torrServer.cacheCleanupIntervalMs)
    this.interval.unref?.()
  }

  async stop() {
    clearInterval(this.interval)
    this.interval = null
    await this.running?.catch(() => {})
  }
}

export function sanitizePathSegment(value, fallback = 'Untitled') {
  let sanitized = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!sanitized) sanitized = fallback
  if (WINDOWS_RESERVED_RE.test(sanitized)) sanitized = `_${sanitized}`
  if (sanitized.length > 120) sanitized = sanitized.slice(0, 120).trimEnd()
  return sanitized
}

const MEDIA_EXTENSION_RE = /\.(?:torrent|mkv|mp4|avi|mov|m4v|ts|m2ts|webm|mpg|mpeg)$/i
const TRACKER_PREFIX_RE = /^\s*\[(?=[^\]]*(?:rutor|rutracker|gtorrent|torrent|(?:[a-z0-9-]+\.)+[a-z]{2,}))[^\]]+\][\s._-]*/iu
const SERIES_TITLE_MARKER_RE = /(?:^|[\s._()[\]-])(?:s\d{1,2}(?:[ ._-]*e\d{1,3})?|seasons?[ ._-]*\d{1,2}(?:[ ._-]*-[ ._-]*\d{1,2})?|сезон(?:ы|а|ов)?[ ._-]*\d{1,2}(?:[ ._-]*-[ ._-]*\d{1,2})?|\d{1,2}x\d{1,3})/iu
const TECHNICAL_TITLE_MARKER_RE = /(?:^|[\s._()[\]-])(?:4320p|2160p|1440p|1080[pi]|720p|576p|480p|8k|4k|uhd|web[ ._-]?(?:dl|rip)|blu[ ._-]?ray|b[dr]rip|remux|hdtv|dvd[ ._-]?rip|hdr10\+?|hdr|dolby[ ._-]?vision|dovi|hevc|x26[45]|h[ ._-]?26[45]|av1|amzn|atvp|netflix|truehd|ddp|dts|aac)(?:$|[\s._()[\]-])/iu

function releaseYearDetails(value) {
  const matches = [...String(value).matchAll(/(^|[^\d])((?:19|20)\d{2})(?=$|[^\d])/g)]
  if (matches.length === 0) return null
  const match = matches.at(-1)
  const index = match.index + match[1].length
  return index > 0 ? { year: match[2], index } : null
}

function preferCyrillicTitle(value) {
  if (!/[а-яё]/iu.test(value)) return value
  const latin = /\s+[a-z][a-z'’&-]*/iu.exec(value)
  return latin && latin.index > 0 ? value.slice(0, latin.index) : value
}

function cleanTitleParts(value, { series = false } = {}) {
  let raw = String(value ?? '')
    .replace(MEDIA_EXTENSION_RE, '')
    .replace(TRACKER_PREFIX_RE, '')
    .replace(/\[?rutracker-\d+\]?/giu, ' ')
    .trim()
  const year = releaseYearDetails(raw)
  const seriesMarker = series ? SERIES_TITLE_MARKER_RE.exec(raw) : null
  const technicalMarker = TECHNICAL_TITLE_MARKER_RE.exec(raw)
  const cutIndexes = []
  if (seriesMarker?.index > 0) cutIndexes.push(seriesMarker.index)
  if (technicalMarker?.index > 0) cutIndexes.push(technicalMarker.index)
  const bracketIndex = raw.indexOf('[')
  if (bracketIndex > 0) cutIndexes.push(bracketIndex)
  if (!seriesMarker) {
    const parenthesisIndex = raw.indexOf('(')
    if (parenthesisIndex > 0) cutIndexes.push(parenthesisIndex)
    if (year?.index > 0) cutIndexes.push(year.index)
  }
  if (cutIndexes.length > 0) raw = raw.slice(0, Math.min(...cutIndexes))
  raw = preferCyrillicTitle(raw)
    .replace(/[._]+/g, ' ')
    .replace(/\s+(?:[-–—|])\s*$/u, '')
    .replace(/[\s[(]+$/u, '')
    .trim()
  return { title: sanitizePathSegment(raw, series ? 'Series' : 'Movie'), year: year?.year || null }
}

export function deriveMovieTitle(torrentTitle, fallback = 'Movie') {
  const cleaned = cleanTitleParts(torrentTitle || fallback)
  return cleaned.year ? `${cleaned.title} (${cleaned.year})` : cleaned.title
}

function cleanTitleCandidate(value) {
  let cleaned = String(value ?? '').trim()
  while (TRACKER_PREFIX_RE.test(cleaned)) cleaned = cleaned.replace(TRACKER_PREFIX_RE, '')
  cleaned = cleaned
    .replace(MEDIA_EXTENSION_RE, '')
    .replace(/\[?rutracker-\d+\]?/giu, ' ')
    .trim()
  const technicalMarker = TECHNICAL_TITLE_MARKER_RE.exec(cleaned)
  if (technicalMarker?.index > 0) cleaned = cleaned.slice(0, technicalMarker.index)
  const bracketIndex = cleaned.indexOf('[')
  if (bracketIndex > 0) cleaned = cleaned.slice(0, bracketIndex)
  cleaned = cleaned
    .replace(/\s+(?:[-–—|])\s*$/u, '')
    .replace(/[\s[(]+$/u, '')
    .trim()
  return cleaned && !HASH_RE.test(cleaned) ? cleaned : null
}

export function selectDisplayTitle(status, sourceName, preference = 'metadata') {
  const candidates = [
    { source: 'metadata', value: cleanTitleCandidate(status?.name) },
    { source: 'uploaded', value: cleanTitleCandidate(status?.title) },
    { source: 'source', value: cleanTitleCandidate(path.basename(String(sourceName || ''), path.extname(String(sourceName || '')))) }
  ].filter((candidate) => candidate.value)
  const unique = []
  const seen = new Set()
  for (const candidate of candidates) {
    const key = candidate.value.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(candidate)
  }
  if (preference === 'localized') {
    const localized = unique.filter((candidate) => /[а-яё]/iu.test(candidate.value))
    if (localized.length === 1) return localized[0]
  }
  return unique.find((candidate) => candidate.source === 'metadata')
    || unique.find((candidate) => candidate.source === 'uploaded')
    || unique[0]
    || { source: 'fallback', value: String(status?.hash || 'Media').slice(0, 8) }
}

function sanitizeOriginalStem(value) {
  let sanitized = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (!sanitized) sanitized = 'video'
  if (WINDOWS_RESERVED_RE.test(sanitized)) sanitized = `_${sanitized}`
  if (sanitized.length > 150) sanitized = sanitized.slice(0, 150).trimEnd()
  return sanitized
}

export function parseEpisode(fileName) {
  const baseName = path.basename(String(fileName), path.extname(String(fileName)))
  const standard = /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?:[ ._-]*e(\d{1,3}))?/i.exec(baseName)
  if (standard) {
    return {
      season: Number(standard[1]),
      episode: Number(standard[2]),
      endEpisode: standard[3] ? Number(standard[3]) : null,
      matchIndex: standard.index + (standard[0].length - standard[0].trimStart().length)
    }
  }
  const alternate = /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?:[-x](\d{1,3}))?/i.exec(baseName)
  if (alternate) {
    return {
      season: Number(alternate[1]),
      episode: Number(alternate[2]),
      endEpisode: alternate[3] ? Number(alternate[3]) : null,
      matchIndex: alternate.index + (alternate[0].length - alternate[0].trimStart().length)
    }
  }
  return null
}

export function deriveSeriesTitle(torrentTitle, fallback = 'Series') {
  return cleanTitleParts(torrentTitle || fallback, { series: true }).title
}

function formatEpisodeCode(episode) {
  const season = String(episode.season).padStart(2, '0')
  const first = String(episode.episode).padStart(2, '0')
  const last = episode.endEpisode ? `-E${String(episode.endEpisode).padStart(2, '0')}` : ''
  return `S${season}E${first}${last}`
}

function normalizedSourceSegments(torrentPath, torrentName) {
  const segments = String(torrentPath).split(/[\\/]+/).filter(Boolean)
  if (segments.length > 1) {
    const first = sanitizePathSegment(segments[0]).toLowerCase()
    const rootName = sanitizePathSegment(torrentName).toLowerCase()
    if (first === rootName || rootName.startsWith(first) || first.startsWith(rootName)) segments.shift()
  }
  return segments
}

function appendIdentitySuffix(target, suffix) {
  const extension = path.extname(target)
  return path.join(path.dirname(target), `${path.basename(target, extension)} [${suffix}]${extension}`)
}

export function buildStreamUrl(config, hash, fileIndex, fileName) {
  const encodedName = encodeURIComponent(path.basename(String(fileName))).replace(/%2F/gi, '')
  return `${config.gateway.publicBaseUrl}/stream/${encodeURIComponent(config.gateway.token)}/${hash}/${fileIndex}/${encodedName}`
}

function normalizeFiles(status) {
  return status.files
    .filter((file) => Number.isInteger(file.index) && file.index >= 0 && file.path)
    .sort((left, right) => left.index - right.index)
}

export function planLibraryEntries(statusInput, sourceName, config, existingRecord = null) {
  const status = statusInput.files ? statusInput : normalizeTorrentStatus(statusInput)
  const extensions = new Set(config.library.videoExtensions)
  const videoFiles = normalizeFiles(status).filter((file) => extensions.has(path.extname(file.path).toLowerCase()))
  if (videoFiles.length === 0) throw new Error('Torrent does not contain supported video files')

  const episodeByIndex = new Map(videoFiles.map((file) => [file.index, parseEpisode(file.path)]))
  const isSeries = [...episodeByIndex.values()].some(Boolean)
  const selectedTitle = selectDisplayTitle(status, sourceName, config.library.titlePreference)
  const displayTitle = selectedTitle.value
  const seriesTitle = deriveSeriesTitle(displayTitle, status.name)
  const movieTitle = deriveMovieTitle(displayTitle, status.hash.slice(0, 8))
  const usedTargets = new Set()

  return videoFiles.map((file) => {
    const sourceSegments = normalizedSourceSegments(file.path, status.name)
    const originalName = sourceSegments.at(-1) || path.basename(file.path)
    const episode = episodeByIndex.get(file.index)
    let outputStem = sanitizeOriginalStem(path.basename(originalName, path.extname(originalName)))
    if (isSeries && episode) outputStem = `${seriesTitle} - ${formatEpisodeCode(episode)}`
    else if (!isSeries && videoFiles.length === 1) outputStem = movieTitle
    const outputName = `${outputStem}.strm`
    let relativeSegments

    if (isSeries && episode) {
      relativeSegments = [
        sanitizePathSegment(config.library.showsFolder),
        seriesTitle,
        `Season ${String(episode.season).padStart(2, '0')}`,
        outputName
      ]
    } else if (isSeries) {
      const directories = sourceSegments.slice(0, -1).map((segment) => sanitizePathSegment(segment))
      relativeSegments = [
        sanitizePathSegment(config.library.showsFolder),
        seriesTitle,
        sanitizePathSegment(config.library.extrasFolder),
        ...directories,
        outputName
      ]
    } else {
      relativeSegments = [
        sanitizePathSegment(config.library.moviesFolder),
        movieTitle,
        outputName
      ]
    }

    let target = safePath(config.paths.library, relativeSegments)
    const normalizedTarget = () => process.platform === 'win32' ? target.toLowerCase() : target
    if (usedTargets.has(normalizedTarget())) target = appendIdentitySuffix(target, `${status.hash.slice(0, 8)}-${file.index}`)
    usedTargets.add(normalizedTarget())

    return {
      index: file.index,
      sourcePath: file.path,
      length: file.length,
      target,
      relativeOutput: path.relative(config.paths.library, target),
      url: buildStreamUrl(config, status.hash, file.index, originalName),
      displayTitle,
      titleSource: selectedTitle.source,
      episode,
      category: isSeries ? 'tv' : 'movie'
    }
  })
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate)
    return true
  } catch {
    return false
  }
}

async function atomicWrite(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`
  await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function commitEntries(entries) {
  const changes = []
  try {
    for (const entry of entries) {
      const existed = await pathExists(entry.target)
      const previous = existed ? await fs.readFile(entry.target) : null
      const desired = `${entry.url}${os.EOL}`
      if (existed && previous.toString('utf8') === desired) continue
      await atomicWrite(entry.target, desired)
      changes.push({ target: entry.target, existed, previous })
    }
  } catch (error) {
    await rollbackChanges(changes)
    throw error
  }
  return changes
}

async function rollbackChanges(changes) {
  for (const change of [...changes].reverse()) {
    if (change.existed) await atomicWrite(change.target, change.previous)
    else await fs.rm(change.target, { force: true })
  }
}

async function filesEqual(left, right) {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)])
  if (leftStat.size !== rightStat.size) return false
  const [leftData, rightData] = await Promise.all([fs.readFile(left), fs.readFile(right)])
  return leftData.equals(rightData)
}

async function moveFile(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL)
    await fs.rm(source)
  }
}

async function waitForStableFile(filePath, delayMs) {
  const before = await fs.stat(filePath)
  if (!before.isFile()) throw new Error('Input is not a regular file')
  if (delayMs > 0) await sleep(delayMs)
  const after = await fs.stat(filePath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('Torrent file is still being written; it will be retried')
  }
}

function pathIdentity(candidate) {
  const resolved = path.resolve(candidate)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isManagedStreamContent(content, hash, fileIndex) {
  try {
    const url = new URL(String(content).trim())
    const segments = url.pathname.split('/').filter(Boolean)
    return segments.length >= 5 &&
      segments[0] === 'stream' &&
      segments[2].toLowerCase() === String(hash).toLowerCase() &&
      segments[3] === String(fileIndex)
  } catch {
    return false
  }
}

async function removeEmptyManagedParents(startDirectory, libraryRoot) {
  const root = path.resolve(libraryRoot)
  let current = path.resolve(startDirectory)
  while (isPathInside(root, current) && path.dirname(current) !== root) {
    try {
      await fs.rmdir(current)
    } catch (error) {
      if (['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) return
      throw error
    }
    current = path.dirname(current)
  }
}

async function removeStaleManagedEntries(config, previousRecord, currentEntries, logger) {
  if (!previousRecord?.files?.length) return 0
  const currentTargets = new Set(currentEntries.map((entry) => pathIdentity(entry.target)))
  let removed = 0
  for (const previousFile of previousRecord.files) {
    const candidate = path.resolve(config.paths.library, previousFile.relativeOutput)
    if (currentTargets.has(pathIdentity(candidate))) continue
    if (!isPathInside(config.paths.library, candidate) || path.extname(candidate).toLowerCase() !== '.strm') {
      await logger.warn('Refusing unsafe stale STRM removal', { hash: previousRecord.hash, index: previousFile.index })
      continue
    }
    try {
      const stat = await fs.lstat(candidate)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) continue
      const content = await fs.readFile(candidate, 'utf8')
      if (!isManagedStreamContent(content, previousRecord.hash, previousFile.index)) continue
      await fs.rm(candidate)
      removed += 1
      await removeEmptyManagedParents(path.dirname(candidate), config.paths.library)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await logger.warn('Cannot remove stale managed STRM', {
          hash: previousRecord.hash,
          index: previousFile.index,
          error: error.message
        })
      }
    }
  }
  if (removed > 0) await logger.info('Stale managed STRM files removed', { hash: previousRecord.hash, removed })
  return removed
}

export class TorrentImporter {
  constructor(config, manager, stateStore, logger) {
    this.config = config
    this.manager = manager
    this.stateStore = stateStore
    this.logger = logger
    this.onImported = null
  }

  async importCore(filePath) {
    await waitForStableFile(filePath, this.config.watch.stableDelayMs)
    let status = await this.manager.uploadTorrent(filePath)
    if (status.files.length === 0 && typeof this.manager.waitForFiles === 'function') {
      status = await this.manager.waitForFiles(status)
    }
    const existingRecord = this.stateStore.get(status.hash)
    let entries = planLibraryEntries(status, path.basename(filePath), this.config, existingRecord)
    entries = await this.resolveConflicts(entries, status, existingRecord)
    const changes = await commitEntries(entries)
    const record = {
      hash: status.hash,
      title: status.title,
      name: status.name,
      layoutVersion: 3,
      category: entries[0].category,
      sourceName: path.basename(filePath),
      archivePath: existingRecord?.archivePath || null,
      importedAt: existingRecord?.importedAt || timestamp(),
      updatedAt: timestamp(),
      files: entries.map((entry) => ({
        index: entry.index,
        sourcePath: entry.sourcePath,
        length: entry.length,
        relativeOutput: path.relative(this.config.paths.library, entry.target)
      }))
    }
    try {
      await this.stateStore.put(record)
    } catch (error) {
      await rollbackChanges(changes)
      throw error
    }
    await removeStaleManagedEntries(this.config, existingRecord, entries, this.logger)
    return record
  }

  async resolveConflicts(entries, status, existingRecord, reservedTargets = new Set()) {
    const managedTargets = new Map((existingRecord?.files || []).map((file) => [
      Number(file.index),
      path.resolve(this.config.paths.library, file.relativeOutput)
    ]))
    const reserved = reservedTargets
    for (const entry of entries) {
      let managedTarget = managedTargets.get(entry.index)
      if (managedTarget && path.resolve(managedTarget) !== path.resolve(entry.target)) {
        managedTarget = null
      }
      if (managedTarget && isPathInside(this.config.paths.library, managedTarget)) {
        entry.target = managedTarget
      }
      let candidate = entry.target
      let attempt = 0
      while (true) {
        const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate
        const exists = await pathExists(candidate)
        const registeredTarget = managedTarget && path.resolve(candidate) === path.resolve(managedTarget)
        const content = exists ? await fs.readFile(candidate, 'utf8').catch(() => '') : ''
        const sameContent = exists && content.trim() === entry.url
        const managedContent = exists && registeredTarget && isManagedStreamContent(content, status.hash, entry.index)
        if (!reserved.has(key) && (!exists || managedContent || sameContent)) break
        attempt += 1
        const suffix = attempt === 1 ? status.hash.slice(0, 8) : `${status.hash.slice(0, 8)}-${entry.index}-${attempt}`
        candidate = appendIdentitySuffix(entry.target, suffix)
      }
      entry.target = candidate
      entry.relativeOutput = path.relative(this.config.paths.library, candidate)
      entry.conflictSuffixApplied = attempt > 0
      reserved.add(process.platform === 'win32' ? candidate.toLowerCase() : candidate)
    }
    return entries
  }

  async archiveSuccess(filePath, record) {
    const stem = sanitizeOriginalStem(path.basename(filePath, path.extname(filePath)))
    let destination = path.join(this.config.paths.processed, `${stem}--${record.hash.slice(0, 8)}.torrent`)
    let destinationAlreadyExisted = false
    if (await pathExists(destination)) {
      destinationAlreadyExisted = true
      if (await filesEqual(filePath, destination)) {
        await fs.rm(filePath)
      } else {
        destination = path.join(this.config.paths.processed, `${stem}--${record.hash.slice(0, 8)}-${Date.now()}.torrent`)
        destinationAlreadyExisted = false
        await moveFile(filePath, destination)
      }
    } else {
      await moveFile(filePath, destination)
    }
    if (record.archivePath !== destination) {
      const updatedRecord = { ...record, archivePath: destination, updatedAt: timestamp() }
      try {
        await this.stateStore.put(updatedRecord)
        Object.assign(record, updatedRecord)
      } catch (error) {
        if (!(await pathExists(filePath)) && await pathExists(destination)) {
          if (destinationAlreadyExisted) await fs.copyFile(destination, filePath)
          else await moveFile(destination, filePath)
        }
        throw error
      }
    }
    return destination
  }

  async archiveFailure(filePath, error) {
    if (!(await pathExists(filePath))) return null
    const stem = sanitizeOriginalStem(path.basename(filePath, path.extname(filePath)))
    const destination = path.join(this.config.paths.failed, `${stem}--${Date.now()}.torrent`)
    await moveFile(filePath, destination)
    await fs.writeFile(`${destination}.error.txt`, `${timestamp()} ${error.stack || error.message}${os.EOL}`, 'utf8')
    return destination
  }

  async processFile(filePath) {
    let record
    try {
      record = await this.importCore(filePath)
    } catch (error) {
      if (/still being written/i.test(error.message)) {
        await this.logger.info('Torrent is not stable yet; postponing import', path.basename(filePath))
        return null
      }
      let failedPath = null
      try {
        failedPath = await this.archiveFailure(filePath, error)
      } catch (archiveError) {
        await this.logger.error('Cannot move failed torrent', archiveError.message)
      }
      await this.logger.error('Torrent import failed', {
        file: filePath,
        failedPath,
        error: error.message
      })
      throw error
    }
    try {
      const archived = await this.archiveSuccess(filePath, record)
      await this.logger.info('Torrent imported', {
        hash: record.hash,
        title: record.title,
        videos: record.files.length,
        archive: archived
      })
    } catch (error) {
      await this.logger.warn('Torrent was imported, but its source could not be archived; it will be retried', {
        file: filePath,
        hash: record.hash,
        error: error.message
      })
    }
    if (this.onImported) {
      Promise.resolve(this.onImported(record)).catch((error) => {
        this.logger.warn('Cannot schedule post-import work', { hash: record.hash, error: error.message })
      })
    }
    return record
  }

  async previewRecord(record, { useTorrServer = true, reservedTargets = new Set() } = {}) {
    let status = useTorrServer ? await this.manager.getTorrent(record.hash).catch(() => null) : null
    let statusSource = 'torrserver'
    if (!status?.files?.length) {
      statusSource = 'registry'
      status = {
        hash: record.hash,
        title: record.title || record.sourceName || record.hash,
        name: record.name || record.title || record.sourceName || record.hash,
        files: (record.files || []).map((file) => ({
          index: Number(file.index),
          path: file.sourcePath,
          length: Number(file.length || 0)
        }))
      }
    }
    let entries = planLibraryEntries(status, record.sourceName, this.config, record)
    entries = await this.resolveConflicts(entries, status, record, reservedTargets)
    const previousByIndex = new Map((record.files || []).map((file) => [Number(file.index), file]))
    const files = entries.map((entry) => {
      const previous = previousByIndex.get(entry.index)
      const previousOutput = previous?.relativeOutput ?? null
      const proposedOutput = path.relative(this.config.paths.library, entry.target)
      if (!isPathInside(this.config.paths.library, entry.target)) {
        throw new Error(`Preview target escapes library: ${entry.target}`)
      }
      let action = previousOutput && pathIdentity(previousOutput) === pathIdentity(proposedOutput)
        ? 'unchanged'
        : previousOutput ? 'rename' : 'create'
      if (entry.conflictSuffixApplied) action = 'conflict-suffixed'
      return {
        hash: record.hash,
        index: entry.index,
        sourcePath: entry.sourcePath,
        oldPath: previousOutput ? path.resolve(this.config.paths.library, previousOutput) : null,
        newPath: entry.target,
        previousOutput,
        proposedOutput,
        displayTitle: entry.displayTitle,
        titleSource: entry.titleSource,
        action
      }
    })
    return {
      hash: record.hash,
      statusSource,
      previousFileCount: (record.files || []).length,
      proposedFileCount: files.length,
      files
    }
  }

  async rebuildRecord(record) {
    let status = await this.manager.getTorrent(record.hash)
    if (status?.files?.length === 0 && typeof this.manager.waitForFiles === 'function') {
      status = await this.manager.waitForFiles(status)
    }
    if (!status || status.files.length === 0) {
      status = await this.restoreRecord(record)
      if (status.files.length === 0 && typeof this.manager.waitForFiles === 'function') {
        status = await this.manager.waitForFiles(status)
      }
    }
    let entries = planLibraryEntries(status, record.sourceName, this.config, record)
    entries = await this.resolveConflicts(entries, status, record)
    const changes = await commitEntries(entries)
    const updated = {
      ...record,
      title: status.title,
      name: status.name,
      layoutVersion: 3,
      updatedAt: timestamp(),
      files: entries.map((entry) => ({
        index: entry.index,
        sourcePath: entry.sourcePath,
        length: entry.length,
        relativeOutput: path.relative(this.config.paths.library, entry.target)
      }))
    }
    try {
      await this.stateStore.put(updated)
    } catch (error) {
      await rollbackChanges(changes)
      throw error
    }
    await removeStaleManagedEntries(this.config, record, entries, this.logger)
    return updated
  }

  async restoreRecord(record) {
    if (!record.archivePath || !(await pathExists(record.archivePath))) {
      throw new Error(`Archived torrent is missing for ${record.hash}`)
    }
    const restored = await this.manager.uploadTorrent(record.archivePath, record.title)
    if (restored.hash !== record.hash) {
      throw new Error(`Restored torrent hash mismatch: expected ${record.hash}, got ${restored.hash}`)
    }
    await this.logger.info('Restored torrent in TorrServer', { hash: record.hash })
    return restored
  }

  async restoreMissing() {
    for (const record of this.stateStore.list()) {
      try {
        const status = await this.manager.getTorrent(record.hash)
        if (!status) await this.restoreRecord(record)
      } catch (error) {
        await this.logger.error('Cannot restore torrent in TorrServer', {
          hash: record.hash,
          archivePath: record.archivePath,
          error: error.message
        })
      }
    }
  }
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual))
  const right = Buffer.from(String(expected))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export function parseContentRangeTotal(value) {
  const raw = Array.isArray(value) ? value[0] : value
  const match = /^bytes\s+(?:\d+-\d+|\*)\/(\d+)$/i.exec(String(raw ?? '').trim())
  if (!match) return null
  const total = Number(match[1])
  return Number.isSafeInteger(total) && total >= 0 ? total : null
}

function sendPlain(response, statusCode, message) {
  if (response.headersSent) {
    response.destroy()
    return
  }
  const payload = Buffer.from(`${message}${os.EOL}`, 'utf8')
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store'
  })
  response.end(payload)
}

export class StreamGateway {
  constructor(config, stateStore, logger, manager = null) {
    this.config = config
    this.stateStore = stateStore
    this.logger = logger
    this.manager = manager
    this.server = null
    this.activeStreams = new Set()
  }

  get activeStreamCount() {
    return this.activeStreams.size
  }

  async start() {
    if (this.server) return this.server.address()
    this.server = http.createServer((request, response) => this.handle(request, response))
    this.server.on('clientError', (error, socket) => {
      const details = { code: error.code || 'UNKNOWN', error: error.message }
      if (['ECONNRESET', 'EPIPE'].includes(error.code) || !socket.writable) {
        socket.destroy()
      } else {
        this.logger.warn('Gateway client error', details)
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      }
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.gateway.port, this.config.gateway.bindAddress, () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    const address = this.server.address()
    await this.logger.info('Streaming gateway started', {
      bind: `${this.config.gateway.bindAddress}:${address.port}`,
      publicBaseUrl: this.config.gateway.publicBaseUrl
    })
    return address
  }

  handle(request, response) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      sendPlain(response, 404, 'Not found')
      return
    }
    let segments
    try {
      segments = new URL(request.url, 'http://gateway.invalid').pathname
        .split('/')
        .filter(Boolean)
        .map(decodeURIComponent)
    } catch {
      sendPlain(response, 404, 'Not found')
      return
    }
    if (segments.length !== 5 || segments[0] !== 'stream') {
      sendPlain(response, 404, 'Not found')
      return
    }
    const [, token, rawHash, rawIndex] = segments
    const hash = rawHash.toLowerCase()
    if (
      !tokenMatches(token, this.config.gateway.token) ||
      !HASH_RE.test(hash) ||
      !VIDEO_ID_RE.test(rawIndex) ||
      !this.stateStore.isAllowed(hash, Number(rawIndex))
    ) {
      sendPlain(response, 404, 'Not found')
      return
    }
    this.proxy(request, response, hash, Number(rawIndex))
  }

  proxy(request, response, hash, fileIndex) {
    const upstreamUrl = new URL(`/play/${hash}/${fileIndex}`, this.config.torrServer.apiUrl)
    const headers = {}
    for (const name of ['range', 'if-range', 'accept', 'user-agent']) {
      if (request.headers[name]) headers[name] = request.headers[name]
    }
    const probesWithRange = request.method === 'HEAD' && !headers.range
    if (probesWithRange) headers.range = 'bytes=0-0'
    const streamId = crypto.randomUUID().slice(0, 8)
    this.activeStreams.add(streamId)
    const startedAt = Date.now()
    let lastDataAt = startedAt
    let firstByteAt = null
    let bytesForwarded = 0
    let settled = false
    let diagnosticsFinished = false
    let stallReported = false
    let checkingStall = false

    const finishDiagnostics = (outcome) => {
      if (diagnosticsFinished) return
      diagnosticsFinished = true
      clearInterval(stallTimer)
      this.activeStreams.delete(streamId)
      this.logger.info('Torrent stream finished', {
        streamId,
        hash,
        fileIndex,
        method: request.method,
        range: headers.range || 'full',
        outcome,
        bytesForwarded,
        firstByteMs: firstByteAt === null ? null : firstByteAt - startedAt,
        durationMs: Date.now() - startedAt
      })
    }

    const readTorrentMetrics = async () => {
      if (!this.manager) return {}
      try {
        const status = await this.manager.getTorrent(hash)
        if (!status) return { torrentStatus: 'missing' }
        return {
          torrentStatus: status.stat_string ?? status.statString ?? status.StatString ?? status.stat ?? status.Stat,
          downloadBytesPerSecond: Number(status.download_speed ?? status.downloadSpeed ?? status.DownloadSpeed ?? 0),
          activePeers: Number(status.active_peers ?? status.activePeers ?? status.ActivePeers ?? 0),
          connectedSeeders: Number(status.connected_seeders ?? status.connectedSeeders ?? status.ConnectedSeeders ?? 0),
          loadedBytes: Number(status.loaded_size ?? status.loadedSize ?? status.LoadedSize ?? 0),
          cachedBytes: Number(status.preloaded_bytes ?? status.preloadedBytes ?? status.PreloadedBytes ?? 0)
        }
      } catch (error) {
        return { metricsError: error.message }
      }
    }

    const stallTimer = setInterval(async () => {
      if (diagnosticsFinished || checkingStall || request.method === 'HEAD') return
      const idleMs = Date.now() - lastDataAt
      if (idleMs < this.config.gateway.stallWarningMs || stallReported) return
      checkingStall = true
      stallReported = true
      try {
        await this.logger.warn('Torrent stream stalled', {
          streamId,
          hash,
          fileIndex,
          range: headers.range || 'full',
          idleMs,
          ...(await readTorrentMetrics())
        })
      } finally {
        checkingStall = false
      }
    }, Math.min(5000, Math.max(50, Math.floor(this.config.gateway.stallWarningMs / 3))))
    stallTimer.unref?.()

    const upstream = http.request(upstreamUrl, { method: 'GET', headers }, (upstreamResponse) => {
      const responseHeaders = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (FORWARDED_RESPONSE_HEADERS.has(name) && value !== undefined) responseHeaders[name] = value
      }
      const upstreamStatusCode = upstreamResponse.statusCode || 502
      let downstreamStatusCode = upstreamStatusCode
      if (probesWithRange && upstreamStatusCode === 206) {
        const total = parseContentRangeTotal(responseHeaders['content-range'])
        downstreamStatusCode = 200
        responseHeaders['accept-ranges'] ??= 'bytes'
        delete responseHeaders['content-range']
        if (total === null) delete responseHeaders['content-length']
        else responseHeaders['content-length'] = String(total)
      }
      upstreamResponse.on('data', (chunk) => {
        const now = Date.now()
        if (firstByteAt === null) firstByteAt = now
        bytesForwarded += chunk.length
        if (stallReported) {
          this.logger.info('Torrent stream resumed', {
            streamId,
            hash,
            fileIndex,
            idleMs: now - lastDataAt
          })
          stallReported = false
        }
        lastDataAt = now
      })
      this.logger.info('Torrent stream response', {
        streamId,
        hash,
        fileIndex,
        method: request.method,
        range: headers.range || 'full',
        statusCode: downstreamStatusCode,
        upstreamStatusCode,
        responseMs: Date.now() - startedAt
      })
      response.writeHead(downstreamStatusCode, responseHeaders)
      if (request.method === 'HEAD') {
        upstreamResponse.destroy()
        response.end()
      } else {
        upstreamResponse.pipe(response)
      }
    })
    const fail = (statusCode, message, error) => {
      if (settled) return
      settled = true
      if (error) this.logger.error(message, { hash, fileIndex, error: error.message })
      sendPlain(response, statusCode, message)
      finishDiagnostics(statusCode === 504 ? 'upstream-timeout' : 'upstream-error')
    }
    upstream.setTimeout(this.config.gateway.upstreamTimeoutMs, () => {
      fail(504, 'Torrent stream timed out')
      upstream.destroy(new Error('No data received before stream timeout'))
    })
    upstream.once('error', (error) => fail(503, 'Torrent stream is unavailable', error))
    request.once('aborted', () => {
      settled = true
      upstream.destroy()
      finishDiagnostics('client-aborted')
    })
    response.once('finish', () => {
      settled = true
      finishDiagnostics('completed')
    })
    response.once('close', () => {
      settled = true
      if (!response.writableEnded) {
        upstream.destroy()
        finishDiagnostics('client-closed')
      }
    })
    upstream.end()
  }

  async stop() {
    if (!this.server) return
    const server = this.server
    this.server = null
    await new Promise((resolve) => {
      const forceClose = setTimeout(() => server.closeAllConnections?.(), 2000)
      forceClose.unref?.()
      server.close(() => {
        clearTimeout(forceClose)
        resolve()
      })
    })
  }
}

export class InboxWatcher {
  constructor(config, importer, logger) {
    this.config = config
    this.importer = importer
    this.logger = logger
    this.watcher = null
    this.interval = null
    this.scanPromise = null
    this.rescanRequested = false
    this.debounceTimer = null
    this.stopped = true
  }

  async scan() {
    if (this.scanPromise) {
      this.rescanRequested = true
      return this.scanPromise
    }
    this.scanPromise = (async () => {
      do {
        this.rescanRequested = false
        const entries = await fs.readdir(this.config.paths.inbox, { withFileTypes: true })
        const torrentFiles = entries
          .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.torrent')
          .map((entry) => path.join(this.config.paths.inbox, entry.name))
          .sort((left, right) => left.localeCompare(right))
        for (const torrentFile of torrentFiles) {
          if (this.stopped) return
          await this.importer.processFile(torrentFile).catch(() => {})
        }
      } while (this.rescanRequested && !this.stopped)
    })().finally(() => {
      this.scanPromise = null
    })
    return this.scanPromise
  }

  scheduleScan() {
    if (this.stopped) return
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.scan().catch((error) => {
      this.logger.error('Inbox scan failed', error.message)
    }), 250)
  }

  async start() {
    this.stopped = false
    this.watcher = fsSync.watch(this.config.paths.inbox, { persistent: true }, (_event, fileName) => {
      if (!fileName || path.extname(String(fileName)).toLowerCase() === '.torrent') this.scheduleScan()
    })
    this.watcher.on('error', (error) => this.logger.error('Inbox watcher failed', error.message))
    this.interval = setInterval(() => this.scheduleScan(), this.config.watch.scanIntervalMs)
    await this.scan()
    await this.logger.info('Watching torrent inbox', this.config.paths.inbox)
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.debounceTimer)
    clearInterval(this.interval)
    this.watcher?.close()
    this.watcher = null
    await this.scanPromise?.catch(() => {})
  }
}

async function walkFiles(root, extension) {
  const found = []
  if (!(await pathExists(root))) return found
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) queue.push(candidate)
      else if (!extension || path.extname(entry.name).toLowerCase() === extension) found.push(candidate)
    }
  }
  return found
}

async function testWritable(directory) {
  const candidate = path.join(directory, `.write-test-${process.pid}-${crypto.randomUUID()}`)
  await fs.writeFile(candidate, 'ok', { flag: 'wx' })
  await fs.rm(candidate)
}

export async function runDoctor(config, manager, stateStore, logger) {
  const checks = []
  const check = async (name, operation) => {
    try {
      const details = await operation()
      if (details && typeof details === 'object' && details.warn) {
        checks.push({ name, ok: true, warn: true, details: details.warn })
      } else {
        checks.push({ name, ok: true, details: details ?? 'ok' })
      }
    } catch (error) {
      checks.push({ name, ok: false, details: error.message })
    }
  }

  await check('Node.js >= 20', async () => {
    const major = Number(process.versions.node.split('.')[0])
    if (major < 20) throw new Error(`found ${process.versions.node}`)
    return process.versions.node
  })
  await check('TorrServer executable', async () => {
    await fs.access(config.torrServer.executable, fsSync.constants.X_OK)
    return config.torrServer.executable
  })
  await check('Writable directories', async () => {
    for (const directory of Object.values(config.paths)) await testWritable(directory)
    return `${Object.keys(config.paths).length} directories`
  })
  await check('TorrServer API and cache', async () => {
    const startedProcess = await manager.ensureStarted()
    if (startedProcess) await manager.configure()
    const settings = await manager.request('/settings', { method: 'POST', body: { action: 'get' } })
    const size = Number(settings.CacheSize ?? settings.cacheSize)
    const useDisk = settings.UseDisk ?? settings.useDisk
    if (size !== config.torrServer.cacheSizeBytes || !useDisk) {
      throw new Error(`unexpected cache settings: size=${size}, useDisk=${useDisk}`)
    }
    return `${size} bytes at ${settings.TorrentsSavePath ?? settings.torrentsSavePath}`
  })
  await check('Global cache usage', async () => {
    const janitor = new CacheJanitor(config, manager, logger)
    const inspected = await janitor.inspect()
    const details = `${inspected.bytes} of ${config.torrServer.cacheSizeBytes} bytes in ${inspected.directories.length} torrent directories`
    if (inspected.bytes > config.torrServer.cacheSizeBytes) {
      return { warn: `${details}; temporary overshoot is allowed, but free space should be monitored` }
    }
    return details
  })
  await check('Public gateway URL', async () => {
    const url = new URL(config.gateway.publicBaseUrl)
    if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && config.gateway.bindAddress === '0.0.0.0') {
      throw new Error('publicBaseUrl points to loopback; LAN Jellyfin clients will not reach it')
    }
    return url.origin
  })
  await check('STRM registry consistency', async () => {
    const files = await walkFiles(config.paths.library, '.strm')
    const expectedOrigin = new URL(config.gateway.publicBaseUrl).origin
    let invalid = 0
    for (const file of files) {
      try {
        const url = new URL((await fs.readFile(file, 'utf8')).trim())
        const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
        if (
          segments.length !== 5 ||
          segments[0] !== 'stream' ||
          url.origin !== expectedOrigin ||
          !tokenMatches(segments[1], config.gateway.token) ||
          !stateStore.isAllowed(segments[2], Number(segments[3]))
        ) invalid += 1
      } catch {
        invalid += 1
      }
    }
    if (invalid) throw new Error(`${invalid} invalid or orphaned STRM files`)
    return `${files.length} STRM files checked`
  })

  for (const result of checks) {
    const marker = result.ok ? (result.warn ? '[WARN]' : '[OK]') : '[FAIL]'
    console.log(`${marker} ${result.name}: ${result.details}`)
  }
  const ok = checks.every((result) => result.ok)
  const warnings = checks.filter((result) => result.warn).length
  await logger.info('Doctor completed', { ok, warnings, checks: checks.length })
  return ok
}

async function initialize(configFile) {
  const config = await loadConfig(configFile)
  await ensureDirectories(config)
  const logger = new Logger(config.paths.logs)
  const stateStore = new StateStore(config.paths.state)
  await stateStore.load()
  const manager = new TorrServerManager(config, logger)
  const importer = new TorrentImporter(config, manager, stateStore, logger)
  const peerMonitor = new PeerMonitor(config, manager, logger)
  return { config, logger, stateStore, manager, importer, peerMonitor }
}

async function prepareTorrServer(context) {
  await context.manager.ensureStarted()
  await context.manager.configure()
}

async function runCommand(context) {
  await prepareTorrServer(context)
  const gateway = new StreamGateway(context.config, context.stateStore, context.logger, context.manager)
  const watcher = new InboxWatcher(context.config, context.importer, context.logger)
  const cacheJanitor = new CacheJanitor(
    context.config,
    context.manager,
    context.logger,
    () => gateway.activeStreamCount > 0
  )
  const metadataWarmup = new MetadataWarmup(
    context.config,
    context.manager,
    context.logger,
    () => gateway.activeStreamCount > 0
  )
  context.peerMonitor.start()
  context.importer.onImported = (record) => {
    metadataWarmup.enqueue(record)
    context.peerMonitor.schedule(record)
  }
  let heartbeat = null
  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    await context.logger.info('Shutting down', signal)
    clearInterval(heartbeat)
    await watcher.stop()
    await metadataWarmup.stop()
    await context.peerMonitor.stop()
    await gateway.stop()
    await cacheJanitor.stop()
    await context.manager.stop()
  }
  try {
    await gateway.start()
    await context.importer.restoreMissing()
    await watcher.start()
    await cacheJanitor.start()
    const recentRecords = context.stateStore.list()
      .sort((left, right) => {
        const rightImported = Date.parse(right.importedAt) || Date.parse(right.updatedAt) || 0
        const leftImported = Date.parse(left.importedAt) || Date.parse(left.updatedAt) || 0
        return rightImported - leftImported
      })
      .slice(0, context.config.torrServer.metadataWarmupRecentTorrents)
    metadataWarmup.start(recentRecords)
    heartbeat = setInterval(() => {
      context.manager.ensureStarted().catch((error) => context.logger.error('TorrServer heartbeat failed', error.message))
    }, 15000)
    await new Promise((resolve, reject) => {
      const onSignal = (signal) => shutdown(signal).then(resolve, reject)
      process.once('SIGINT', () => onSignal('SIGINT'))
      process.once('SIGTERM', () => onSignal('SIGTERM'))
    })
  } catch (error) {
    await shutdown('startup failure')
    throw error
  }
}

export async function createRebuildPreview(context, reportFile) {
  const useTorrServer = await context.manager.health()
  const torrents = []
  const reservedTargets = new Set()
  let errors = 0
  let previousFiles = 0
  let proposedFiles = 0
  let renamed = 0
  let created = 0
  let unchanged = 0
  let conflicts = 0
  for (const record of context.stateStore.list()) {
    try {
      const preview = await context.importer.previewRecord(record, { useTorrServer, reservedTargets })
      previousFiles += preview.previousFileCount
      proposedFiles += preview.proposedFileCount
      for (const file of preview.files) {
        if (file.action === 'unchanged') unchanged += 1
        else if (file.action === 'conflict-suffixed') conflicts += 1
        else if (file.action === 'create') created += 1
        else renamed += 1
      }
      torrents.push(preview)
    } catch (error) {
      errors += 1
      torrents.push({ hash: record.hash, action: 'error', error: error.message, files: [] })
    }
  }
  const report = {
    generatedAt: timestamp(),
    dryRun: true,
    titlePreference: context.config.library.titlePreference,
    torrServerAvailable: useTorrServer,
    summary: {
      torrents: torrents.length,
      previousFiles,
      proposedFiles,
      unchanged,
      renamed,
      created,
      conflicts,
      errors,
      outsideLibrary: 0,
      userFilesOverwritten: 0,
      fileCountChanged: previousFiles !== proposedFiles
    },
    torrents
  }
  const resolvedReport = path.resolve(reportFile || path.join(context.config.paths.state, 'rebuild-preview.json'))
  await atomicWrite(resolvedReport, `${JSON.stringify(report, null, 2)}${os.EOL}`)
  console.log(`Rebuild preview: ${resolvedReport}`)
  console.log(JSON.stringify(report.summary))
  await context.logger.info('STRM rebuild preview created', { report: resolvedReport, ...report.summary })
  return { report, reportFile: resolvedReport }
}

async function backupImportRegistry(config) {
  const source = path.join(config.paths.state, STATE_FILE_NAME)
  const stamp = timestamp().replace(/[:.]/g, '-')
  const destination = path.join(config.paths.state, `${STATE_FILE_NAME}.backup-${stamp}`)
  if (await pathExists(source)) await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL)
  else await atomicWrite(destination, `${JSON.stringify({ version: 1, imports: {} }, null, 2)}${os.EOL}`)
  return destination
}

function assertSafeRebuildPreview(preview) {
  const summary = preview.report.summary
  const unsafe = []
  if (summary.errors !== 0) unsafe.push(`${summary.errors} preview errors`)
  if (summary.outsideLibrary !== 0) unsafe.push(`${summary.outsideLibrary} paths outside the library`)
  if (summary.userFilesOverwritten !== 0) unsafe.push(`${summary.userFilesOverwritten} user files would be overwritten`)
  if (summary.fileCountChanged) unsafe.push(`managed entry count changes from ${summary.previousFiles} to ${summary.proposedFiles}`)
  if (unsafe.length > 0) throw new Error(`Refusing unsafe rebuild: ${unsafe.join('; ')}`)
}

function parseArguments(argv) {
  const args = [...argv]
  const command = args.shift() || 'run'
  let configFile = path.join(SCRIPT_DIR, 'config.json')
  let dryRun = false
  let reportFile = null
  const positionals = []
  while (args.length > 0) {
    const value = args.shift()
    if (value === '--config') {
      if (args.length === 0) throw new Error('--config requires a file path')
      configFile = args.shift()
    } else if (value === '--dry-run') {
      dryRun = true
    } else if (value === '--report') {
      if (args.length === 0) throw new Error('--report requires a file path')
      reportFile = args.shift()
    } else {
      positionals.push(value)
    }
  }
  return { command, configFile, positionals, dryRun, reportFile }
}

function printHelp() {
  console.log(`Jellyfin Torrent Streamer

Usage:
  node torrent-jellyfin.mjs run [--config <file>]
  node torrent-jellyfin.mjs import <file.torrent> [--config <file>]
  node torrent-jellyfin.mjs rebuild [--dry-run] [--report <file>] [--config <file>]
  node torrent-jellyfin.mjs doctor [--config <file>]
`)
}

export async function main(argv = process.argv.slice(2)) {
  const { command, configFile, positionals, dryRun, reportFile } = parseArguments(argv)
  if (['help', '--help', '-h'].includes(command)) {
    printHelp()
    return 0
  }
  const context = await initialize(configFile)
  try {
    if (command === 'run') {
      await runCommand(context)
    } else if (command === 'import') {
      if (positionals.length !== 1) throw new Error('import requires exactly one .torrent file')
      const torrentFile = path.resolve(positionals[0])
      if (path.extname(torrentFile).toLowerCase() !== '.torrent') throw new Error('Input file must have the .torrent extension')
      await prepareTorrServer(context)
      context.peerMonitor.start()
      context.importer.onImported = (record) => context.peerMonitor.schedule(record)
      await context.importer.processFile(torrentFile)
      await context.peerMonitor.drain()
    } else if (command === 'rebuild') {
      if (positionals.length !== 0) throw new Error('rebuild does not accept positional arguments')
      if (reportFile && !dryRun) throw new Error('--report requires --dry-run')
      if (dryRun) {
        const preview = await createRebuildPreview(context, reportFile)
        return preview.report.summary.errors === 0 ? 0 : 1
      }
      await prepareTorrServer(context)
      const backup = await backupImportRegistry(context.config)
      const preview = await createRebuildPreview(context)
      assertSafeRebuildPreview(preview)
      let rebuilt = 0
      for (const record of context.stateStore.list()) {
        await context.importer.rebuildRecord(record)
        rebuilt += 1
      }
      await context.logger.info('STRM library rebuilt', { torrents: rebuilt, registryBackup: backup })
    } else if (command === 'doctor') {
      const ok = await runDoctor(context.config, context.manager, context.stateStore, context.logger)
      return ok ? 0 : 1
    } else {
      printHelp()
      throw new Error(`Unknown command: ${command}`)
    }
    return 0
  } finally {
    if (command !== 'run') {
      await context.peerMonitor.stop()
      await context.manager.stop()
    }
  }
}

const isEntrypoint = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isEntrypoint) {
  main().then((exitCode) => {
    process.exitCode = exitCode
  }).catch((error) => {
    console.error(`${timestamp()} ERROR ${error.stack || error.message}`)
    process.exitCode = 1
  })
}
