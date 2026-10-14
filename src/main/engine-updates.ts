// Keeps the GPU inference engines current between app releases.
//
// The runtime store publishes a signed engine index per platform (see src/shared/engine-updates.ts).
// When "Keep engines up to date" is on (the default), the app checks it shortly after launch and
// every few hours, downloads only the files it does not already have, starts the new engine once
// to prove it runs, and then makes it the first engine searched. The previous release stays on
// disk, and the CUDA pack's own engine stays behind both, so a launch that fails falls back.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  engineFileUrl,
  engineFolderName,
  engineIndexUrl,
  enginesToInstall,
  ENGINE_SIGNING_PUBLIC_KEY,
  parseEngineIndex,
  verifyEngineIndexSignature,
  type EngineFile,
  type EngineIndex,
  type EnginePlatform,
  type EngineRelease,
  type EngineUpdateStatus
} from '../shared/engine-updates'
import { engineSpawnEnv } from './llm/spawn-env'

const execFileAsync = promisify(execFile)
const FIRST_CHECK_DELAY_MS = 60_000
const CHECK_INTERVAL_MS = 6 * 60 * 60_000
const INDEX_TIMEOUT_MS = 15_000
const SMOKE_TEST_TIMEOUT_MS = 30_000

/** Everything outside this module the updater touches, injectable for tests. */
export interface EngineUpdaterDeps {
  platform: NodeJS.Platform
  /** The folder that holds `engines/`. */
  dataDir: () => string
  appVersion: () => string
  enabled: () => boolean
  setEnabled: (enabled: boolean) => void
  /** Engines only help machines with an NVIDIA GPU. */
  hasGpu: () => boolean
  /** The installed CUDA pack's bin folder, whose identical files are reused instead of downloaded. */
  packBin: () => string | null
  fetch?: typeof fetch
  indexUrl?: (platform: EnginePlatform) => string
  fileUrl?: (sha256: string) => string
  publicKey?: string
}

interface InstalledEngines {
  platform: EnginePlatform
  /** Active release per engine id, plus the one it replaced for rollback. */
  engines: Record<string, { version: string; folder: string; previousFolder?: string }>
}

export interface EngineUpdater {
  status(): EngineUpdateStatus
  /** Folders to search for engine binaries, before the CUDA pack. */
  activeRoots(): string[]
  check(): Promise<EngineUpdateStatus>
  setEnabled(enabled: boolean): Promise<EngineUpdateStatus>
  onChanged(callback: (status: EngineUpdateStatus) => void): void
  start(): void
  stop(): void
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function createEngineUpdater(deps: EngineUpdaterDeps): EngineUpdater {
  const doFetch = deps.fetch ?? fetch
  const platform: EnginePlatform | null =
    deps.platform === 'linux' || deps.platform === 'win32' ? deps.platform : null
  const root = (): string => path.join(deps.dataDir(), 'engines')
  const filesDir = (): string => path.join(root(), 'files')
  const recordPath = (): string => path.join(root(), 'installed.json')
  let phase: EngineUpdateStatus['phase'] = 'idle'
  let error: string | undefined
  let lastCheckedAt: number | undefined
  let downloadedBytes = 0
  let totalBytes = 0
  let running: Promise<EngineUpdateStatus> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let notify: ((status: EngineUpdateStatus) => void) | undefined

  function readRecord(): InstalledEngines | null {
    if (!platform) return null
    try {
      const record: unknown = JSON.parse(fs.readFileSync(recordPath(), 'utf8'))
      const candidate = record as Partial<InstalledEngines> | null
      return candidate?.platform === platform &&
        candidate.engines &&
        typeof candidate.engines === 'object'
        ? (candidate as InstalledEngines)
        : null
    } catch {
      return null
    }
  }

  function writeRecord(record: InstalledEngines): void {
    fs.mkdirSync(root(), { recursive: true })
    const temporary = `${recordPath()}.partial`
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
    fs.renameSync(temporary, recordPath())
  }

  function installedVersions(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(readRecord()?.engines ?? {}).map(([id, engine]) => [id, engine.version])
    )
  }

  function status(): EngineUpdateStatus {
    const enabled = deps.enabled()
    const base = {
      enabled,
      installed: installedVersions(),
      downloadedBytes,
      totalBytes,
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(error ? { error } : {})
    }
    if (!platform || !deps.hasGpu()) return { ...base, phase: 'unsupported' }
    if (!enabled && phase !== 'downloading' && phase !== 'installing') {
      return { ...base, phase: 'disabled' }
    }
    return { ...base, phase }
  }

  const publish = (): void => notify?.(status())

  function activeRoots(): string[] {
    const record = readRecord()
    if (!record) return []
    return Object.values(record.engines)
      .map((engine) => path.join(root(), engine.folder))
      .filter((folder) => fs.existsSync(folder))
  }

  /** The published index, or null when the store publishes none for this platform (HTTP 404). */
  async function fetchIndex(): Promise<EngineIndex | null> {
    const url = (deps.indexUrl ?? engineIndexUrl)(platform!)
    const get = async (target: string): Promise<Buffer | null> => {
      const response = await doFetch(target, {
        cache: 'no-store',
        signal: AbortSignal.timeout(INDEX_TIMEOUT_MS)
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`The engine store returned HTTP ${response.status}.`)
      return Buffer.from(await response.arrayBuffer())
    }
    const [body, signature] = await Promise.all([get(url), get(`${url}.sig`)])
    if (body === null) return null
    if (signature === null) throw new Error('The engine store returned HTTP 404.')
    if (
      !verifyEngineIndexSignature(
        body,
        signature.toString('utf8'),
        deps.publicKey ?? ENGINE_SIGNING_PUBLIC_KEY
      )
    ) {
      throw new Error('The engine index signature is not valid.')
    }
    const index = parseEngineIndex(JSON.parse(body.toString('utf8')), platform!)
    if (!index) throw new Error('The engine index could not be read.')
    return index
  }

  /**
   * The cached copy of `file`. An identical file already on disk, in the CUDA pack or in the
   * engine's current release, is copied instead of downloaded.
   */
  async function ensureFile(file: EngineFile, release: EngineRelease): Promise<string> {
    const target = path.join(filesDir(), file.sha256)
    if (fs.existsSync(target) && fs.statSync(target).size === file.size) {
      downloadedBytes += file.size
      publish()
      return target
    }
    fs.mkdirSync(filesDir(), { recursive: true })
    const partial = `${target}.partial`
    const currentFolder = readRecord()?.engines[release.id]?.folder
    const localCopies = [deps.packBin(), currentFolder ? path.join(root(), currentFolder) : null]
      .filter((folder): folder is string => Boolean(folder))
      .map((folder) => path.join(folder, ...file.path.split('/')))
    for (const copy of localCopies) {
      if (!fs.existsSync(copy) || fs.statSync(copy).size !== file.size) continue
      if ((await sha256Of(copy)) !== file.sha256) continue
      await fs.promises.copyFile(copy, partial)
      await fs.promises.rename(partial, target)
      downloadedBytes += file.size
      publish()
      return target
    }
    const response = await doFetch((deps.fileUrl ?? engineFileUrl)(file.sha256))
    if (!response.ok || !response.body) {
      throw new Error(`Downloading ${file.path} failed with HTTP ${response.status}.`)
    }
    const hash = createHash('sha256')
    let received = 0
    const out = fs.createWriteStream(partial)
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength
        if (received > file.size) throw new Error(`${file.path} is larger than published.`)
        hash.update(chunk)
        if (!out.write(chunk))
          await new Promise<void>((resolve) => out.once('drain', () => resolve()))
        downloadedBytes += chunk.byteLength
        publish()
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve()))
      )
    } catch (err) {
      out.destroy()
      fs.rmSync(partial, { force: true })
      throw err
    }
    if (received !== file.size || hash.digest('hex') !== file.sha256) {
      fs.rmSync(partial, { force: true })
      throw new Error(`${file.path} did not match its published checksum.`)
    }
    await fs.promises.rename(partial, target)
    return target
  }

  async function smokeTest(folder: string, release: EngineRelease): Promise<void> {
    const executable = path.join(folder, ...release.smokeTest.split('/'))
    const env = {
      ...process.env,
      ...engineSpawnEnv({
        platform: deps.platform,
        binDir: path.dirname(executable),
        currentEnv: process.env
      })
    }
    try {
      await execFileAsync(executable, ['--version'], { env, timeout: SMOKE_TEST_TIMEOUT_MS })
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err)
      throw new Error(`The new ${release.id} engine did not start: ${detail}`)
    }
  }

  async function install(release: EngineRelease): Promise<void> {
    const folderName = engineFolderName(platform!, release)
    const folder = path.join(root(), folderName)
    const staging = path.join(root(), `.staging-${folderName}`)
    fs.rmSync(staging, { recursive: true, force: true })
    for (const file of release.files) {
      const cached = await ensureFile(file, release)
      const destination = path.join(staging, ...file.path.split('/'))
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await fs.promises.copyFile(cached, destination)
      if (platform !== 'win32') await fs.promises.chmod(destination, file.mode ?? 0o644)
    }
    phase = 'installing'
    publish()
    if (platform !== 'win32') {
      for (const link of release.links ?? []) {
        const destination = path.join(staging, ...link.path.split('/'))
        await fs.promises.mkdir(path.dirname(destination), { recursive: true })
        await fs.promises.symlink(link.target, destination)
      }
    }
    try {
      await smokeTest(staging, release)
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true })
      throw err
    }
    fs.rmSync(folder, { recursive: true, force: true })
    fs.renameSync(staging, folder)
    const record = readRecord() ?? { platform: platform!, engines: {} }
    const current = record.engines[release.id]
    const previousFolder =
      current && current.folder !== folderName ? current.folder : current?.previousFolder
    record.engines[release.id] = {
      version: release.version,
      folder: folderName,
      ...(previousFolder ? { previousFolder } : {})
    }
    writeRecord(record)
    prune(record)
  }

  /** Remove releases and cached files that neither the active nor the previous release uses. */
  function prune(record: InstalledEngines): void {
    const keep = new Set(
      Object.values(record.engines).flatMap((engine) =>
        engine.previousFolder ? [engine.folder, engine.previousFolder] : [engine.folder]
      )
    )
    for (const entry of fs.readdirSync(root())) {
      if (entry === 'files' || entry === 'installed.json' || keep.has(entry)) continue
      if (entry.startsWith(`${platform}-`))
        fs.rmSync(path.join(root(), entry), { recursive: true, force: true })
    }
  }

  async function runCheck(): Promise<EngineUpdateStatus> {
    if (!platform || !deps.hasGpu() || !deps.enabled()) return status()
    phase = 'checking'
    error = undefined
    publish()
    try {
      const index = await fetchIndex()
      const pending = index ? enginesToInstall(index, installedVersions(), deps.appVersion()) : []
      if (pending.length) {
        downloadedBytes = 0
        totalBytes = pending
          .flatMap((release) => release.files)
          .reduce((sum, file) => sum + file.size, 0)
        phase = 'downloading'
        publish()
        for (const release of pending) await install(release)
      }
      // Every file now lives in an installed engine folder, which the next update reuses, so the
      // download cache is only worth keeping while an install is unfinished.
      fs.rmSync(filesDir(), { recursive: true, force: true })
      phase = 'up-to-date'
    } catch (err) {
      phase = 'failed'
      error = err instanceof Error ? err.message : 'The engine update failed.'
    } finally {
      lastCheckedAt = Date.now()
      downloadedBytes = 0
      totalBytes = 0
    }
    process.env.OFFGRID_ENGINE_ROOTS = activeRoots().join(path.delimiter)
    publish()
    return status()
  }

  function check(): Promise<EngineUpdateStatus> {
    running ??= runCheck().finally(() => {
      running = null
    })
    return running
  }

  function schedule(delay: number): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void check().finally(() => schedule(CHECK_INTERVAL_MS))
    }, delay)
    timer.unref()
  }

  return {
    status,
    activeRoots,
    check,
    async setEnabled(enabled) {
      deps.setEnabled(enabled)
      if (enabled) return check()
      publish()
      return status()
    },
    onChanged(callback) {
      notify = callback
    },
    start() {
      process.env.OFFGRID_ENGINE_ROOTS = activeRoots().join(path.delimiter)
      if (platform) schedule(FIRST_CHECK_DELAY_MS)
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
