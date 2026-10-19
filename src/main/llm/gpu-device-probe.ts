import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { engineSpawnEnv } from './spawn-env'

const execFileAsync = promisify(execFile)

/** A GPU candidate must name a device for its own backend before it outranks CPU. */
export function hasGpuDevice(output: string, backend: 'CUDA' | 'Vulkan'): boolean {
  const devices = output.split(/Available devices:/i)[1]
  if (!devices) return false
  const deviceLine = new RegExp(`^\\s*${backend}\\d+\\s*:`)
  return devices.split(/\r?\n/).some((line) => {
    if (!deviceLine.test(line)) return false
    return (
      backend === 'CUDA' ||
      !/llvmpipe|lavapipe|softpipe|swiftshader|basic render driver/i.test(line)
    )
  })
}

/** The largest memory, in MiB, that the device list reports for one of this backend's GPUs
 *  (llama.cpp prints `Vulkan0: NAME (8188 MiB, 7800 MiB free)`), or null when it names none. */
export function listedGpuMemoryMB(output: string, backend: 'CUDA' | 'Vulkan'): number | null {
  const devices = output.split(/Available devices:/i)[1]
  if (!devices) return null
  const line = new RegExp(`^\\s*${backend}\\d+\\s*:.*\\((\\d+)\\s*MiB`)
  const sizes = devices
    .split(/\r?\n/)
    .map((entry) => line.exec(entry)?.[1])
    .filter((size): size is string => size !== undefined)
    .map(Number)
  return sizes.length ? Math.max(...sizes) : null
}

/** Each engine's last device listing, kept so a launch can read the GPU's memory without
 *  probing again. */
const deviceListings = new Map<string, string>()

/** The GPU memory, in MiB, the last probe of this engine reported, or null. */
export function probedGpuMemoryMB(serverPath: string, backend: 'CUDA' | 'Vulkan'): number | null {
  const listing = deviceListings.get(serverPath)
  return listing ? listedGpuMemoryMB(listing, backend) : null
}

/** The engine's own model-load log is the proof that layers reached a GPU. */
export function offloadedGpuLayers(output: string): number | null {
  const matches = [...output.matchAll(/\boffloaded\s+(\d+)\/\d+\s+layers to GPU\b/gi)]
  const count = matches.at(-1)?.[1]
  return count === undefined ? null : Number(count)
}

/** The layers the engine placed on the GPU out of the model's total, from its load log. */
export function offloadedLayerShare(output: string): { layers: number; total: number } | null {
  const match = [...output.matchAll(/\boffloaded\s+(\d+)\/(\d+)\s+layers to GPU\b/gi)].at(-1)
  return match ? { layers: Number(match[1]), total: Number(match[2]) } : null
}

export async function gpuDeviceAvailable(
  serverPath: string,
  backend: 'CUDA' | 'Vulkan',
  platform: NodeJS.Platform,
  inherited: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const binDir = path.dirname(serverPath)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout, stderr } = await execFileAsync(serverPath, ['--list-devices'], {
        timeout: 30_000,
        maxBuffer: 512 * 1024,
        env: { ...inherited, ...engineSpawnEnv({ platform, binDir, currentEnv: inherited }) }
      })
      const listing = `${stdout}\n${stderr}`
      deviceListings.set(serverPath, listing)
      return hasGpuDevice(listing, backend)
    } catch (error) {
      console.warn(`[LLMService] ${backend} device probe failed for ${serverPath}:`, error)
    }
  }
  return false
}
