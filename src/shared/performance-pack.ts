export interface PerformancePackAsset {
  url: string
  sha256: string
  bytes: number
  version: string
}

export interface PerformancePackManifest {
  schemaVersion: 1
  cuda: Partial<Record<'win32' | 'linux', PerformancePackAsset>>
}

export type PerformancePackPhase =
  | 'unavailable'
  | 'not-needed'
  | 'available'
  | 'downloading'
  | 'paused'
  | 'failed'
  | 'installed'

export interface PerformancePackStatus {
  phase: PerformancePackPhase
  bytes: number
  downloadedBytes: number
  version?: string
  error?: string
  restartRequired?: boolean
}

const PACK_ORIGIN = 'https://runtime.getoffgridai.co'
const SHA256 = /^[a-f0-9]{64}$/i
const SAFE_VERSION = /^[a-zA-Z0-9._-]+$/

/** The CUDA pack for `platform`, or null when it is malformed or not served from the runtime store. */
export function parsePerformancePackAsset(
  value: unknown,
  platform: 'win32' | 'linux'
): PerformancePackAsset | null {
  const asset = value as Partial<PerformancePackAsset> | null
  if (!asset || typeof asset.url !== 'string' || typeof asset.version !== 'string') return null
  if (!SAFE_VERSION.test(asset.version)) return null
  if (typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) return null
  if (!Number.isSafeInteger(asset.bytes) || (asset.bytes as number) <= 0) return null
  try {
    const url = new URL(asset.url)
    if (url.origin !== PACK_ORIGIN || url.pathname !== `/desktop/cuda/${platform}/${asset.version}.tar.gz`) return null
  } catch {
    return null
  }
  return { url: asset.url, sha256: asset.sha256, bytes: asset.bytes as number, version: asset.version }
}
