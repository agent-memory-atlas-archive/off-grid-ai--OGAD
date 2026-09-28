import type { RuntimeBackend, RuntimeId } from '../shared/runtime-backends'
import { currentAIRequest } from './ai-request-log'

const live = new Map<RuntimeId, RuntimeBackend>()

export function runtimeBackendSnapshot(): RuntimeBackend[] {
  return [...live.values()].map((value) => ({ ...value }))
}

/** A process-scoped lease prevents late output/exit from replacing a newer model. */
export function beginRuntimeBackend(id: RuntimeId, model: string) {
  const record: RuntimeBackend = { id, model, state: 'loading' }
  const startingRequest = currentAIRequest()
  live.set(id, record)
  const update = (value: Partial<RuntimeBackend>): void => {
    if (live.get(id) === record && record.state !== 'stopped' && record.state !== 'error') {
      Object.assign(record, value)
      startingRequest?.useRuntime(record)
    }
  }
  let output = ''
  return {
    /** Capture this process, not whichever process is currently in the global list. */
    recordRequest: (request = currentAIRequest()): void => {
      request?.useRuntime(record)
    },
    ready: (backend?: string, device?: string, detail?: string): void =>
      update({
        state: 'loaded',
        ...(backend && !record.backend ? { backend } : {}),
        ...(device ? { device } : {}),
        ...(detail ? { detail } : {})
      }),
    observe: (chunk: string, loaded = false): void => {
      output = (output + chunk).slice(-65536)
      const placement = parseNativeBackend(output)
      if (placement) update({ ...placement, ...(loaded ? { state: 'loaded' as const } : {}) })
    },
    stop: (): void => update({ state: 'stopped', backend: undefined, device: undefined }),
    fail: (error: unknown): void =>
      update({
        state: 'error',
        backend: undefined,
        device: undefined,
        detail: String(error instanceof Error ? error.message : error).slice(0, 1000)
      })
  }
}

/** Only allocation/selection messages count. A device list or compiled feature does not. */
export function parseNativeBackend(
  output: string
): Pick<RuntimeBackend, 'backend' | 'device'> | undefined {
  const explicit = /OFFGRID_BACKEND:(Core ML|Metal|CPU)\b/.exec(output)?.[1]
  if (explicit) return { backend: explicit }
  const used = new Set<string>()
  for (const match of output.matchAll(
    /(?:using\s+(CUDA\d*|Vulkan\d*|Metal|CPU)\s+backend|\b(CUDA\d*|Vulkan\d*|Metal|CPU)\s+(?:total\s+)?(?:model\s+)?buffer\s+size\s*=\s*([\d.]+)|backend\s*=\s*(CUDA\d*|Vulkan\d*|Metal|CPU)\b)/gi
  )) {
    if (match[3] !== undefined && Number(match[3]) === 0) continue
    const raw = (match[1] || match[2] || match[4] || '').toLowerCase()
    used.add(
      raw.startsWith('cuda')
        ? 'CUDA'
        : raw.startsWith('vulkan')
          ? 'Vulkan'
          : raw === 'metal'
            ? 'Metal'
            : 'CPU'
    )
  }
  for (const failed of output.matchAll(
    /failed to initialize (CUDA\d*|Vulkan\d*|Metal|CPU) backend/gi
  )) {
    const name = failed[1]!.toLowerCase()
    used.delete(
      name.startsWith('cuda')
        ? 'CUDA'
        : name.startsWith('vulkan')
          ? 'Vulkan'
          : name === 'metal'
            ? 'Metal'
            : 'CPU'
    )
  }
  if (!used.size) return undefined
  const backend = [...used]
    .sort((a, b) => (a === 'CPU' ? 1 : b === 'CPU' ? -1 : a.localeCompare(b)))
    .join(' + ')
  const device = /using device\s+(?:CUDA\d*|Vulkan\d*|Metal)\s*\(([^)]+)\)/i.exec(output)?.[1]
  return { backend, ...(device ? { device } : {}) }
}

export function providerLabel(device: string): string {
  return (
    (
      {
        cuda: 'CUDA',
        dml: 'DirectML',
        coreml: 'Core ML',
        webgpu: 'WebGPU',
        cpu: 'CPU',
        wasm: 'CPU (WASM)',
        mps: 'Metal'
      } as Record<string, string>
    )[device] ?? device
  )
}
