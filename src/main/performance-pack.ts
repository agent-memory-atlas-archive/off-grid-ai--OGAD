import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  parsePerformancePackAsset,
  type PerformancePackAsset,
  type PerformancePackManifest,
  type PerformancePackStatus
} from '../shared/performance-pack'
import { dataDir, resourceFile } from './runtime-env'
import { hasWindowsNvidiaDriver, hasLinuxNvidiaDriver } from './transcription/whisper-runtime'

const execFileAsync = promisify(execFile)
let controller: AbortController | null = null
let task: Promise<void> | null = null
let phase: PerformancePackStatus['phase'] | null = null
let downloadedBytes = 0
let errorMessage: string | undefined
let installedThisSession = false
let notify: ((status: PerformancePackStatus) => void) | undefined

// The signed engine index names the current pack; the engine updater hands it here and it is kept in
// LIVE_FILE. Without one, the pack built into this app release is used.
const LIVE_FILE = 'live.json'

function packsDir(): string {
  return path.join(dataDir(), 'performance-packs')
}

function packPlatform(): 'win32' | 'linux' | null {
  return process.platform === 'win32' || process.platform === 'linux' ? process.platform : null
}

function liveAsset(): PerformancePackAsset | null {
  const platform = packPlatform()
  if (!platform) return null
  try {
    return parsePerformancePackAsset(JSON.parse(fs.readFileSync(path.join(packsDir(), LIVE_FILE), 'utf8')), platform)
  } catch {
    return null
  }
}

function bundledAsset(): PerformancePackAsset | null {
  const platform = packPlatform()
  const manifestPath = resourceFile('performance-packs.json')
  if (!platform || !manifestPath) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Omit<PerformancePackManifest, 'schemaVersion'> & { schemaVersion?: number }
    if (manifest.schemaVersion !== 1) return null
    return parsePerformancePackAsset(manifest.cuda[platform], platform)
  } catch {
    return null
  }
}

function manifestAsset(): PerformancePackAsset | null {
  return liveAsset() ?? bundledAsset()
}

function hasNvidiaDriver(): boolean {
  return process.platform === 'win32'
    ? hasWindowsNvidiaDriver()
    : process.platform === 'linux' && hasLinuxNvidiaDriver()
}

function packRoot(asset: PerformancePackAsset): string {
  return path.join(packsDir(), `cuda-${asset.version}-${asset.sha256.slice(0, 12)}`)
}

function installedBin(asset: PerformancePackAsset): string | null {
  const root = packRoot(asset)
  const marker = path.join(root, 'verified.sha256')
  try {
    if (fs.readFileSync(marker, 'utf8').trim() !== asset.sha256.toLowerCase()) return null
    const bin = path.join(root, 'bin')
    if (!fs.statSync(bin).isDirectory()) return null
    return bin
  } catch {
    return null
  }
}

/** A verified pack older than the current one, which keeps working until the current one is in. */
function previousPack(): { bin: string; version: string } | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(packsDir())
  } catch {
    return null
  }
  for (const entry of entries.filter((name) => /^cuda-.+-[a-f0-9]{12}$/.test(name)).sort().reverse()) {
    const root = path.join(packsDir(), entry)
    const bin = path.join(root, 'bin')
    if (fs.existsSync(path.join(root, 'verified.sha256')) && fs.existsSync(bin)) {
      return { bin, version: entry.slice('cuda-'.length, -13) }
    }
  }
  return null
}

function activeBin(asset: PerformancePackAsset | null): string | null {
  return (asset && installedBin(asset)) ?? previousPack()?.bin ?? null
}

/** Delete packs other than the active one and the current one's unfinished download. Runs before any
 *  engine starts, so no file in them is in use. */
function pruneOldPacks(asset: PerformancePackAsset | null, bin: string | null): void {
  const keep = [bin ? path.basename(path.dirname(bin)) : null, asset ? path.basename(packRoot(asset)) : null]
  let entries: string[]
  try {
    entries = fs.readdirSync(packsDir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith('cuda-') || keep.some((name) => name && (entry === name || entry.startsWith(`${name}.`)))) continue
    try {
      // The marker goes first, so a folder a locked file keeps half-deleted is never used again.
      fs.rmSync(path.join(packsDir(), entry, 'verified.sha256'), { force: true })
      fs.rmSync(path.join(packsDir(), entry), { recursive: true, force: true })
    } catch (error) {
      console.warn('[performance-pack] could not remove', entry, error)
    }
  }
}

/** Run once during main-process setup and after installation. */
export function activateInstalledPerformancePack(): void {
  const asset = manifestAsset()
  const bin = activeBin(asset)
  if (bin) process.env.OFFGRID_PERFORMANCE_PACK_BIN = bin
  else delete process.env.OFFGRID_PERFORMANCE_PACK_BIN
  if (!task) pruneOldPacks(asset, bin)
}

/**
 * Record the pack the signed engine index names. A machine that already has an older pack gets the
 * new one in the background and keeps the old one until it is in; a machine without one still
 * chooses to download it.
 */
export function offerPerformancePack(asset: PerformancePackAsset): void {
  if (!packPlatform()) return
  if (liveAsset()?.sha256 !== asset.sha256) {
    fs.mkdirSync(packsDir(), { recursive: true })
    const file = path.join(packsDir(), LIVE_FILE)
    fs.writeFileSync(`${file}.partial`, `${JSON.stringify(asset, null, 2)}\n`)
    fs.renameSync(`${file}.partial`, file)
    publish()
  }
  if (!installedBin(asset) && previousPack() && hasNvidiaDriver()) startPerformancePack()
}

/** ONNX loads CUDA with dlopen, so Linux must see these libraries at process start. */
export function prepareInstalledOnnxCudaLibraries(): boolean {
  if (process.platform !== 'linux') return false
  const asset = manifestAsset()
  const bin = activeBin(asset)
  if (!bin) return false
  const libraries = path.join(bin, 'onnx-cuda')
  if (!fs.existsSync(path.join(libraries, 'libcublasLt.so.13')) ||
      !fs.existsSync(path.join(libraries, 'libcudnn.so.9'))) return false
  const current = (process.env.LD_LIBRARY_PATH ?? '').split(':').filter(Boolean)
  if (current.includes(libraries)) return false
  process.env.LD_LIBRARY_PATH = [libraries, ...current].join(':')
  return true
}

export function performancePackStatus(): PerformancePackStatus {
  const asset = manifestAsset()
  if (!asset) return { phase: 'unavailable', bytes: 0, downloadedBytes: 0 }
  if (!hasNvidiaDriver()) return { phase: 'not-needed', bytes: 0, downloadedBytes: 0 }
  if (installedBin(asset)) {
    return {
      phase: 'installed', bytes: asset.bytes, downloadedBytes: asset.bytes,
      version: asset.version, restartRequired: installedThisSession
    }
  }
  // The newer pack downloads in the background while the older one keeps CUDA running.
  const previous = previousPack()
  if (previous) return { phase: 'installed', bytes: 0, downloadedBytes: 0, version: previous.version }
  const current = phase ?? 'available'
  return {
    phase: current,
    bytes: asset.bytes,
    downloadedBytes,
    version: asset.version,
    ...(errorMessage ? { error: errorMessage } : {})
  }
}

function publish(): void {
  notify?.(performancePackStatus())
}

export function onPerformancePackChanged(callback: (status: PerformancePackStatus) => void): void {
  notify = callback
}

async function digest(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadArchive(asset: PerformancePackAsset, archive: string, existing: number, signal: AbortSignal): Promise<void> {
  const response = await fetch(asset.url, {
    signal,
    headers: existing > 0 ? { Range: `bytes=${existing}-` } : undefined
  })
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const append = existing > 0 && response.status === 206
  if (append && !response.headers.get('content-range')?.startsWith(`bytes ${existing}-`)) {
    throw new Error('The server returned an invalid resume range.')
  }
  const stream = fs.createWriteStream(archive, { flags: append ? 'a' : 'w' })
  downloadedBytes = append ? existing : 0
  publish()
  let lastProgressPublishedAt = Date.now()
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) throw signal.reason
      if (!stream.write(value)) {
        await new Promise<void>((resolve, reject) => {
          stream.once('drain', resolve)
          stream.once('error', reject)
        })
      }
      downloadedBytes += value.byteLength
      if (downloadedBytes > asset.bytes) throw new Error('The download is larger than expected.')
      const now = Date.now()
      if (now - lastProgressPublishedAt >= 250 || downloadedBytes === asset.bytes) {
        publish()
        lastProgressPublishedAt = now
      }
    }
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.end(resolve)
    })
  } catch (error) {
    stream.destroy()
    throw error
  }
}

async function fetchPack(asset: PerformancePackAsset, signal: AbortSignal): Promise<void> {
  const root = packRoot(asset)
  const parent = path.dirname(root)
  fs.mkdirSync(parent, { recursive: true })
  const archive = `${root}.tar.gz.part`
  const existing = fs.existsSync(archive) ? fs.statSync(archive).size : 0
  // A complete archive left by a failed unpack goes straight to the check; asking for more bytes gets HTTP 416.
  if (existing === asset.bytes) downloadedBytes = existing
  else await downloadArchive(asset, archive, existing, signal)
  // Pause stops the check, the unpack and the install too, not only the download.
  signal.throwIfAborted()
  if (downloadedBytes !== asset.bytes || (await digest(archive)) !== asset.sha256.toLowerCase()) {
    fs.rmSync(archive, { force: true })
    throw new Error('The downloaded performance files failed the size or hash check.')
  }
  signal.throwIfAborted()
  const staging = `${root}.staging`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    await execFileAsync('tar', ['--no-same-owner', '-xzf', archive, '-C', staging], {
      timeout: 30 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      signal
    })
    const bin = path.join(staging, 'bin')
    const server = path.join(bin, 'llama-cuda', process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')
    if (!fs.statSync(bin).isDirectory() || !fs.statSync(server).isFile()) {
      throw new Error('The performance pack is missing its CUDA chat engine.')
    }
    if (process.platform === 'linux' &&
        (!fs.existsSync(path.join(bin, 'onnx-cuda', 'libcublasLt.so.13')) ||
         !fs.existsSync(path.join(bin, 'onnx-cuda', 'libcudnn.so.9')))) {
      throw new Error('The performance pack is missing its CUDA speech libraries.')
    }
    signal.throwIfAborted()
    fs.writeFileSync(path.join(staging, 'verified.sha256'), `${asset.sha256.toLowerCase()}\n`)
    fs.rmSync(root, { recursive: true, force: true })
    fs.renameSync(staging, root)
    fs.rmSync(archive, { force: true })
    installedThisSession = true
    activateInstalledPerformancePack()
    // The CUDA engine is now available: auto-managed installs move onto it.
    void import('./best-settings').then((m) => {
      m.forgetDetectedMachine()
      return m.ensureBestSettings()
    }).catch((error: unknown) => console.warn('[best-settings] CUDA refresh failed', error))
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

export function startPerformancePack(): PerformancePackStatus {
  const asset = manifestAsset()
  if (!asset || !hasNvidiaDriver() || installedBin(asset)) return performancePackStatus()
  if (task !== null) return performancePackStatus()
  phase = 'downloading'
  errorMessage = undefined
  controller = new AbortController()
  const signal = controller.signal
  publish()
  task = fetchPack(asset, signal)
    .then(() => { phase = 'installed' })
    .catch((error: unknown) => {
      if (signal.aborted) phase = 'paused'
      else {
        phase = 'failed'
        errorMessage = error instanceof Error ? error.message : String(error)
      }
    })
    .finally(() => {
      controller = null
      task = null
      publish()
    })
  return performancePackStatus()
}

export function pausePerformancePack(): PerformancePackStatus {
  controller?.abort(new Error('Download paused'))
  return performancePackStatus()
}
