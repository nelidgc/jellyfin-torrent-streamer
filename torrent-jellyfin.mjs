#!/usr/bin/env node

import fsSync from 'node:fs'
import { promises as fs } from 'node:fs'
import http from 'node:http'
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
  parsed.torrServer.preloadPercent = toInteger(parsed.torrServer.preloadPercent ?? 1, 'torrServer.preloadPercent', 0)
  if (parsed.torrServer.preloadPercent > 100) throw new Error('torrServer.preloadPercent must not exceed 100')
  parsed.torrServer.manageProcess = parsed.torrServer.manageProcess !== false

  parsed.gateway.bindAddress ||= '0.0.0.0'
  parsed.gateway.port = toInteger(parsed.gateway.port ?? 8091, 'gateway.port', 0)
  parsed.gateway.publicBaseUrl = ensureTrailingSlashRemoved(parsed.gateway.publicBaseUrl || 'http://127.0.0.1:8091')
  parsed.gateway.upstreamTimeoutMs = toInteger(parsed.gateway.upstreamTimeoutMs ?? 120000, 'gateway.upstreamTimeoutMs', 1000)
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
  parsed.library.moviesFolder ||= 'Movies'
  parsed.library.showsFolder ||= 'TV Shows'
  parsed.library.extrasFolder ||= 'Extras'
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

  async ensureStarted() {
    if (await this.health()) return false
    if (!this.config.torrServer.manageProcess) {
      throw new Error(`TorrServer is unavailable at ${this.config.torrServer.apiUrl}`)
    }
    await fs.access(this.config.torrServer.executable, fsSync.constants.X_OK).catch(() => {
      throw new Error(`TorrServer executable not found: ${this.config.torrServer.executable}. Run install.ps1.`)
    })
    if (!this.child) this.startProcess()
    const deadline = Date.now() + this.config.torrServer.startupTimeoutMs
    while (Date.now() < deadline) {
      if (await this.health()) {
        await this.logger.info('TorrServer is ready', { url: this.config.torrServer.apiUrl })
        return true
      }
      if (this.spawnError) throw new Error(`Cannot start TorrServer: ${this.spawnError.message}`)
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) break
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
    const updated = {
      ...current,
      CacheSize: this.config.torrServer.cacheSizeBytes,
      UseDisk: true,
      TorrentsSavePath: this.config.paths.cache,
      RemoveCacheOnDrop: false,
      PreloadCache: this.config.torrServer.preloadPercent,
      DisableUPNP: true
    }
    await this.request('/settings', { method: 'POST', body: { action: 'set', sets: updated } })
    await this.logger.info('TorrServer cache configured', {
      bytes: updated.CacheSize,
      path: updated.TorrentsSavePath,
      preloadPercent: updated.PreloadCache,
      disableUpnp: updated.DisableUPNP,
      peerBindAddress: this.config.torrServer.peerBindAddress || 'system routing'
    })
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
  const raw = path.basename(String(torrentTitle || fallback), path.extname(String(torrentTitle || fallback)))
  const marker = /(?:^|[ ._-])(?:s\d{1,2}(?:[ ._-]*e\d{1,3})?|season[ ._-]*\d{1,2}|\d{1,2}x\d{1,3})/i.exec(raw)
  const candidate = marker && marker.index > 0 ? raw.slice(0, marker.index) : raw
  return sanitizePathSegment(candidate.replace(/\[[^\]]*]/g, ' '), sanitizePathSegment(fallback))
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
  const displayTitle = status.title || status.name || path.basename(sourceName, path.extname(sourceName))
  const seriesTitle = deriveSeriesTitle(displayTitle, status.name)
  const movieTitle = sanitizePathSegment(displayTitle, status.hash.slice(0, 8))
  const existingByIndex = new Map((existingRecord?.files || []).map((file) => [Number(file.index), file]))
  const usedTargets = new Set()

  return videoFiles.map((file) => {
    const sourceSegments = normalizedSourceSegments(file.path, status.name)
    const originalName = sourceSegments.at(-1) || path.basename(file.path)
    const outputName = `${sanitizeOriginalStem(path.basename(originalName, path.extname(originalName)))}.strm`
    const episode = episodeByIndex.get(file.index)
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
      const directories = sourceSegments.slice(0, -1).map((segment) => sanitizePathSegment(segment))
      relativeSegments = [
        sanitizePathSegment(config.library.moviesFolder),
        movieTitle,
        ...directories,
        outputName
      ]
    }

    const previousRelative = existingByIndex.get(file.index)?.relativeOutput
    if (previousRelative) {
      const previousTarget = path.resolve(config.paths.library, previousRelative)
      const previousSegments = previousRelative.split(/[\\/]+/).filter(Boolean)
      const expectedLibraryFolder = sanitizePathSegment(
        isSeries ? config.library.showsFolder : config.library.moviesFolder
      )
      const matchesCurrentLayout = previousSegments[0]?.toLowerCase() === expectedLibraryFolder.toLowerCase()
      if (
        matchesCurrentLayout &&
        isPathInside(config.paths.library, previousTarget) &&
        path.extname(previousTarget).toLowerCase() === '.strm'
      ) {
        relativeSegments = path.relative(config.paths.library, previousTarget).split(path.sep)
      }
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

export class TorrentImporter {
  constructor(config, manager, stateStore, logger) {
    this.config = config
    this.manager = manager
    this.stateStore = stateStore
    this.logger = logger
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
    return record
  }

  async resolveConflicts(entries, status, existingRecord) {
    const managedTargets = new Map((existingRecord?.files || []).map((file) => [
      Number(file.index),
      path.resolve(this.config.paths.library, file.relativeOutput)
    ]))
    const reserved = new Set()
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
        const isManaged = managedTarget && path.resolve(candidate) === path.resolve(managedTarget)
        const sameContent = exists
          ? (await fs.readFile(candidate, 'utf8').catch(() => '')).trim() === entry.url
          : false
        if (!reserved.has(key) && (!exists || isManaged || sameContent)) break
        attempt += 1
        const suffix = attempt === 1 ? status.hash.slice(0, 8) : `${status.hash.slice(0, 8)}-${entry.index}-${attempt}`
        candidate = appendIdentitySuffix(entry.target, suffix)
      }
      entry.target = candidate
      entry.relativeOutput = path.relative(this.config.paths.library, candidate)
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
    return record
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
  constructor(config, stateStore, logger) {
    this.config = config
    this.stateStore = stateStore
    this.logger = logger
    this.server = null
  }

  async start() {
    if (this.server) return this.server.address()
    this.server = http.createServer((request, response) => this.handle(request, response))
    this.server.on('clientError', (error, socket) => {
      this.logger.warn('Gateway client error', error.message)
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
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
    if (request.method === 'HEAD' && !headers.range) headers.range = 'bytes=0-0'
    const upstream = http.request(upstreamUrl, { method: 'GET', headers }, (upstreamResponse) => {
      const responseHeaders = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (FORWARDED_RESPONSE_HEADERS.has(name) && value !== undefined) responseHeaders[name] = value
      }
      response.writeHead(upstreamResponse.statusCode || 502, responseHeaders)
      if (request.method === 'HEAD') {
        upstreamResponse.destroy()
        response.end()
      } else {
        upstreamResponse.pipe(response)
      }
    })
    let settled = false
    const fail = (statusCode, message, error) => {
      if (settled) return
      settled = true
      if (error) this.logger.error(message, { hash, fileIndex, error: error.message })
      sendPlain(response, statusCode, message)
    }
    upstream.setTimeout(this.config.gateway.upstreamTimeoutMs, () => {
      upstream.destroy(new Error('No data received before stream timeout'))
      fail(504, 'Torrent stream timed out')
    })
    upstream.once('error', (error) => fail(503, 'Torrent stream is unavailable', error))
    request.once('aborted', () => upstream.destroy())
    response.once('close', () => {
      settled = true
      if (!response.writableEnded) upstream.destroy()
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
      checks.push({ name, ok: true, details: details ?? 'ok' })
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
    await manager.ensureStarted()
    await manager.configure()
    const settings = await manager.request('/settings', { method: 'POST', body: { action: 'get' } })
    const size = Number(settings.CacheSize ?? settings.cacheSize)
    const useDisk = settings.UseDisk ?? settings.useDisk
    if (size !== config.torrServer.cacheSizeBytes || !useDisk) {
      throw new Error(`unexpected cache settings: size=${size}, useDisk=${useDisk}`)
    }
    return `${size} bytes at ${settings.TorrentsSavePath ?? settings.torrentsSavePath}`
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
    const marker = result.ok ? '[OK]' : '[FAIL]'
    console.log(`${marker} ${result.name}: ${result.details}`)
  }
  const ok = checks.every((result) => result.ok)
  await logger.info('Doctor completed', { ok, checks: checks.length })
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
  return { config, logger, stateStore, manager, importer }
}

async function prepareTorrServer(context) {
  await context.manager.ensureStarted()
  await context.manager.configure()
}

async function runCommand(context) {
  await prepareTorrServer(context)
  await context.importer.restoreMissing()
  const gateway = new StreamGateway(context.config, context.stateStore, context.logger)
  const watcher = new InboxWatcher(context.config, context.importer, context.logger)
  let heartbeat = null
  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    await context.logger.info('Shutting down', signal)
    clearInterval(heartbeat)
    await watcher.stop()
    await gateway.stop()
    await context.manager.stop()
  }
  try {
    await gateway.start()
    await watcher.start()
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

function parseArguments(argv) {
  const args = [...argv]
  const command = args.shift() || 'run'
  let configFile = path.join(SCRIPT_DIR, 'config.json')
  const positionals = []
  while (args.length > 0) {
    const value = args.shift()
    if (value === '--config') {
      if (args.length === 0) throw new Error('--config requires a file path')
      configFile = args.shift()
    } else {
      positionals.push(value)
    }
  }
  return { command, configFile, positionals }
}

function printHelp() {
  console.log(`Jellyfin Torrent Streamer

Usage:
  node torrent-jellyfin.mjs run [--config <file>]
  node torrent-jellyfin.mjs import <file.torrent> [--config <file>]
  node torrent-jellyfin.mjs rebuild [--config <file>]
  node torrent-jellyfin.mjs doctor [--config <file>]
`)
}

export async function main(argv = process.argv.slice(2)) {
  const { command, configFile, positionals } = parseArguments(argv)
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
      await context.importer.processFile(torrentFile)
    } else if (command === 'rebuild') {
      await prepareTorrServer(context)
      let rebuilt = 0
      for (const record of context.stateStore.list()) {
        await context.importer.rebuildRecord(record)
        rebuilt += 1
      }
      await context.logger.info('STRM library rebuilt', { torrents: rebuilt })
    } else if (command === 'doctor') {
      const ok = await runDoctor(context.config, context.manager, context.stateStore, context.logger)
      return ok ? 0 : 1
    } else {
      printHelp()
      throw new Error(`Unknown command: ${command}`)
    }
    return 0
  } finally {
    if (command !== 'run') await context.manager.stop()
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
