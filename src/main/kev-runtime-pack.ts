// Kev's Python runtime (Python, PyTorch, MLX: about 250 MB compressed) is too large to ship in
// the Mac app: Squirrel.Mac crashes on an update zip past 1 GiB. The runtime store publishes it
// as one sha256-pinned archive, and the app fetches it in the same job that downloads a Kev
// model, or the first time an existing Kev install starts without it.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dataDir, isPackaged, resourceFile } from './runtime-env'

const execFileAsync = promisify(execFile)
const RUNTIME_STORE = 'https://runtime.getoffgridai.co'
const MANIFEST = 'kev-runtime-packs.json'
const SHA256 = /^[a-f0-9]{64}$/i
const VERSION = /^[a-zA-Z0-9._-]+$/

export interface KevRuntimeAsset {
  url: string
  sha256: string
  bytes: number
  version: string
}

type KevRuntimeTarget = 'darwin-arm64'

function currentTarget(): KevRuntimeTarget | null {
  return process.platform === 'darwin' && process.arch === 'arm64' ? 'darwin-arm64' : null
}

/** A development or test host may serve the archive from this machine; a packaged app never. */
function trustedUrl(url: URL, target: KevRuntimeTarget, version: string): boolean {
  if (url.origin === RUNTIME_STORE) {
    return url.pathname === `/desktop/kev-runtime/${target}/${version}.tar.gz`
  }
  return !isPackaged() && url.protocol === 'http:' && url.hostname === '127.0.0.1'
}

/** The pinned runtime archive for this machine, or null when this platform bundles its own. */
export function kevRuntimeAsset(): KevRuntimeAsset | null {
  const target = currentTarget()
  const manifestPath = target && resourceFile(MANIFEST)
  if (!target || !manifestPath) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      schemaVersion?: number
    } & Partial<Record<KevRuntimeTarget, KevRuntimeAsset>>
    const asset = manifest[target]
    if (
      manifest.schemaVersion !== 1 ||
      !asset ||
      !VERSION.test(asset.version) ||
      !SHA256.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      !trustedUrl(new URL(asset.url), target, asset.version)
    )
      return null
    return asset
  } catch {
    return null
  }
}

function installRoot(asset: KevRuntimeAsset): string {
  return path.join(
    dataDir(),
    'kev-runtime',
    `${asset.version}-${asset.sha256.slice(0, 12).toLowerCase()}`
  )
}

/** The folder that holds `kev-runtime/` once the pinned archive is installed and verified. */
export function installedKevRuntimeRoot(): string | null {
  const asset = kevRuntimeAsset()
  if (!asset) return null
  const root = installRoot(asset)
  try {
    const marker = fs.readFileSync(path.join(root, 'verified.sha256'), 'utf8').trim()
    if (marker !== asset.sha256.toLowerCase()) return null
    return fs.statSync(path.join(root, 'kev-runtime', 'python', 'bin', 'python3')).isFile()
      ? root
      : null
  } catch {
    return null
  }
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export interface KevRuntimeInstallOptions {
  signal: AbortSignal
  /** Bytes of the archive on disk so far, out of `asset.bytes`. */
  onBytes?: (downloadedBytes: number) => void
}

/** Fetch the archive into `archive`, resuming a partial file. Returns the bytes on disk. */
async function downloadArchive(
  asset: KevRuntimeAsset,
  archive: string,
  { signal, onBytes }: KevRuntimeInstallOptions
): Promise<number> {
  const existing = fs.existsSync(archive) ? fs.statSync(archive).size : 0
  if (existing > asset.bytes) fs.rmSync(archive, { force: true })
  const resumeFrom = existing > asset.bytes ? 0 : existing
  if (resumeFrom === asset.bytes) return resumeFrom
  const response = await fetch(asset.url, {
    signal,
    headers: resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : undefined
  })
  if (!response.ok || !response.body) {
    throw new Error(`The Kev runtime download failed: HTTP ${response.status}`)
  }
  const append = resumeFrom > 0 && response.status === 206
  if (append && !response.headers.get('content-range')?.startsWith(`bytes ${resumeFrom}-`)) {
    throw new Error('The Kev runtime server returned an invalid resume range.')
  }
  let downloaded = append ? resumeFrom : 0
  onBytes?.(downloaded)
  const stream = fs.createWriteStream(archive, { flags: append ? 'a' : 'w' })
  // A write error (disk full, folder removed) can fire between awaits; keep it for the loop
  // to throw, so it never reaches the process as an unhandled 'error' event.
  let streamError: Error | null = null
  stream.on('error', (error) => {
    streamError = error
  })
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (signal.aborted) throw signal.reason
      // The stream's error listener sets streamError between reads; TypeScript cannot see that.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (streamError) throw streamError
      if (!stream.write(value)) {
        await new Promise<void>((resolve, reject) => {
          stream.once('drain', resolve)
          stream.once('error', reject)
        })
      }
      downloaded += value.byteLength
      if (downloaded > asset.bytes) {
        throw new Error('The Kev runtime download is larger than expected.')
      }
      onBytes?.(downloaded)
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (streamError) throw streamError
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject)
      stream.end(resolve)
    })
  } catch (error) {
    stream.destroy()
    // A larger-than-pinned file can never verify; an interrupted one resumes next time.
    if (downloaded > asset.bytes) fs.rmSync(archive, { force: true })
    throw error
  }
  return downloaded
}

/** Unpack a verified archive beside `root`, then swap it into place in one rename. */
async function installArchive(
  asset: KevRuntimeAsset,
  archive: string,
  root: string
): Promise<void> {
  const staging = `${root}.staging`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    await execFileAsync('tar', ['-xzf', archive, '-C', staging], { timeout: 600_000 })
    const python = path.join(staging, 'kev-runtime', 'python', 'bin', 'python3')
    if (!fs.existsSync(python) || !fs.statSync(python).isFile()) {
      throw new Error('The Kev runtime archive has no Python.')
    }
    fs.writeFileSync(path.join(staging, 'verified.sha256'), `${asset.sha256.toLowerCase()}\n`)
    fs.rmSync(root, { recursive: true, force: true })
    fs.renameSync(staging, root)
    fs.rmSync(archive, { force: true })
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/** Download (resuming a partial archive), verify and atomically install the pinned runtime. */
export async function installKevRuntime(
  asset: KevRuntimeAsset,
  options: KevRuntimeInstallOptions
): Promise<void> {
  const root = installRoot(asset)
  fs.mkdirSync(path.dirname(root), { recursive: true })
  const archive = `${root}.tar.gz.part`
  const downloaded = await downloadArchive(asset, archive, options)
  if (downloaded !== asset.bytes || (await sha256Of(archive)) !== asset.sha256.toLowerCase()) {
    fs.rmSync(archive, { force: true })
    throw new Error('The Kev runtime download failed its size or SHA-256 check.')
  }
  await installArchive(asset, archive, root)
  // Older pinned runtimes are unreachable now; keep only the one this app version uses.
  for (const entry of fs.readdirSync(path.dirname(root))) {
    const candidate = path.join(path.dirname(root), entry)
    if (candidate !== root && !candidate.startsWith(`${root}.`)) {
      fs.rmSync(candidate, { recursive: true, force: true })
    }
  }
}
