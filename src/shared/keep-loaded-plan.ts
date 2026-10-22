// "Keep several models loaded": one pure decision from the machine and the chosen models to each
// model's llama-server settings under the gateway's router (llama-server --models-preset). The
// main process reads the hardware and the GGUF headers and runs the router; this file only decides.
//
// Measured on an RTX PRO 6000 (96 GB) pod with a 13.6-core CPU quota and six models at 16K: the
// MoE models kept about half their expert layers on the CPU so all six fit in about 85 GB, and 2
// threads per model with poll = 0 gave 26–46 tok/s each, where 16–24 threads each oversubscribed
// the quota and gave 4–10 tok/s.

import {
  GPU_FIT_MARGIN_GB,
  KV_GB_PER_1K_TOKENS,
  LLM_COMPUTE_BUFFER_MB,
  METAL_WORKING_SET_SHARE,
  kvBytesPerToken,
  type KvShape
} from '@offgrid/models'

export type KeepLoadedKvCache = 'f16' | 'q8_0' | 'q4_0'

/** The context each kept model launches with. */
export const KEEP_LOADED_CTX_SIZE = 16_384
/** Share of RAM the kept models may hold on the CPU side (spilled experts and layers). */
export const KEEP_LOADED_RAM_SHARE = 0.8
/** RAM left for the app and the OS, GB. */
export const KEEP_LOADED_RAM_RESERVE_GB = 2
/** Share of an MoE model's weights in its expert tensors (the part `n-cpu-moe` moves). Kept low
 *  so a spill never moves less than the plan counts on. */
export const MOE_EXPERT_SHARE = 0.85
/** More threads per model stop paying once the model runs mostly on the GPU. */
export const MAX_THREADS_PER_MODEL = 8
/** `n-gpu-layers` for "every layer on the GPU". */
export const ALL_GPU_LAYERS = 999

const COMPUTE_BUFFER_GB = LLM_COMPUTE_BUFFER_MB / 1024
const KV_ORDER: KeepLoadedKvCache[] = ['f16', 'q8_0', 'q4_0']

export interface KeepLoadedMachine {
  /** Memory the GPU can hold models in, GB: VRAM on a card, the Metal working set on a Mac.
   *  Null when there is no usable GPU. */
  gpuMemoryGb: number | null
  /** GPU and CPU share one memory (Apple Silicon): spilling to the CPU frees nothing. */
  unifiedMemory: boolean
  totalRamGb: number
  /** Cores the process may use: the logical count capped by any container CPU quota. */
  usableCores: number
  /** GPU memory other engines already hold, GB. */
  reservedGpuGb?: number
  /** RAM other engines already hold, GB. */
  reservedRamGb?: number
}

/** A GPU that reports at least this share of the machine's RAM shares that memory with the CPU
 *  (a DGX Spark's GB10 reports the whole 128 GB). */
export const SHARED_GPU_RAM_SHARE = 0.85

/**
 * The GPU memory the planner may use, and whether the CPU shares it. A Mac and a board whose GPU
 * reports about all of the machine's RAM (DGX Spark) share one memory: the GPU gets the working-set
 * share of RAM and spilling to the CPU frees nothing. An ARM Linux GPU that reports no memory is
 * taken as shared too (nvidia-smi gives none on GB10). Counting such memory twice, once as VRAM and
 * once as RAM, would plan a launch that runs out of memory.
 */
export function keepLoadedGpuMemory(input: {
  platform: string
  arch: string
  /** A GPU engine found a usable device. */
  gpuPresent: boolean
  /** The memory the GPU reports, GB, or null when it reports none. */
  reportedGpuGb: number | null
  totalRamGb: number
}): Pick<KeepLoadedMachine, 'gpuMemoryGb' | 'unifiedMemory'> {
  const shared = { gpuMemoryGb: input.totalRamGb * METAL_WORKING_SET_SHARE, unifiedMemory: true }
  if (input.platform === 'darwin') return shared
  if (!input.gpuPresent) return { gpuMemoryGb: null, unifiedMemory: false }
  if (input.reportedGpuGb === null)
    return input.platform === 'linux' && input.arch === 'arm64'
      ? shared
      : { gpuMemoryGb: null, unifiedMemory: false }
  if (input.reportedGpuGb >= input.totalRamGb * SHARED_GPU_RAM_SHARE) return shared
  return { gpuMemoryGb: input.reportedGpuGb, unifiedMemory: false }
}

export interface KeepLoadedModel {
  id: string
  /** The main GGUF, GB. */
  weightsGb: number
  /** The vision projector, GB (0 when none). It stays on the GPU. */
  mmprojGb: number
  /** A mixture-of-experts model (GGUF expert_count above zero). */
  isMoe: boolean
  /** Repeating layers (GGUF block_count). */
  layers: number
  /** The attention shape from the GGUF header; null falls back to a safe per-token estimate. */
  kvShape?: KvShape | null
}

export interface KeepLoadedModelPlan {
  id: string
  nGpuLayers: number
  /** Leading layers whose expert tensors stay on the CPU (MoE only). */
  nCpuMoe: number
  ctxSize: number
  kvCacheType: KeepLoadedKvCache
  threads: number
  /** Busy-wait percent while waiting for work; 0 lets several engines share the cores. */
  poll: 0
  /** What this model holds on the GPU and in RAM, GB. */
  gpuGb: number
  ramGb: number
}

export type KeepLoadedFailure = 'memory' | 'cpu'

export interface KeepLoadedPlan {
  fits: boolean
  /** Why the set does not fit; absent when it fits. */
  reason?: KeepLoadedFailure
  /** One plain line for the person when the set does not fit. */
  message?: string
  /** Each model's settings. When the set does not fit, the closest attempt (for the memory bar). */
  models: KeepLoadedModelPlan[]
  gpuBudgetGb: number
  ramBudgetGb: number
  gpuUsedGb: number
  ramUsedGb: number
  threadsTotal: number
}

function kvGb(model: KeepLoadedModel, ctxSize: number, kv: KeepLoadedKvCache): number {
  if (model.kvShape) return (ctxSize * kvBytesPerToken(model.kvShape, kv, kv)) / 1024 ** 3
  return (ctxSize / 1000) * KV_GB_PER_1K_TOKENS[kv]
}

/** Threads per model: an even share of the usable cores, never above the per-model cap. */
export function keepLoadedThreads(usableCores: number, modelCount: number): number {
  if (modelCount <= 0) return 0
  return Math.max(1, Math.min(MAX_THREADS_PER_MODEL, Math.floor(usableCores / modelCount)))
}

interface Placement {
  nGpuLayers: number
  nCpuMoe: number
  gpuGb: number
  ramGb: number
}

/**
 * Place every model at one KV cache type. On a discrete card the GPU overflow first goes to the MoE
 * models' experts, in proportion to their expert weights (the cheapest bytes to move: only the
 * active experts are read per token), then to whole layers of the dense models. Returns the GPU
 * memory still short (0 when everything fits the GPU budget).
 */
function place(
  models: KeepLoadedModel[],
  ctxSize: number,
  kv: KeepLoadedKvCache,
  machine: KeepLoadedMachine,
  gpuBudgetGb: number
): { placements: Placement[]; gpuShortGb: number } {
  const need = models.map(
    (m) => m.weightsGb + m.mmprojGb + kvGb(m, ctxSize, kv) + COMPUTE_BUFFER_GB
  )
  // No GPU: everything runs from RAM.
  if (machine.gpuMemoryGb === null || !(machine.gpuMemoryGb > 0)) {
    return {
      placements: need.map((ramGb) => ({ nGpuLayers: 0, nCpuMoe: 0, gpuGb: 0, ramGb })),
      gpuShortGb: 0
    }
  }
  const full = need.reduce((a, b) => a + b, 0)
  const placements: Placement[] = need.map((gpuGb) => ({
    nGpuLayers: ALL_GPU_LAYERS,
    nCpuMoe: 0,
    gpuGb,
    ramGb: 0
  }))
  let overflow = Math.max(0, full - gpuBudgetGb)
  // Unified memory: moving tensors to the CPU frees nothing.
  if (overflow <= 0 || machine.unifiedMemory) return { placements, gpuShortGb: overflow }

  const expertGb = models.map((m) => (m.isMoe && m.layers > 0 ? m.weightsGb * MOE_EXPERT_SHARE : 0))
  const totalExpertGb = expertGb.reduce((a, b) => a + b, 0)
  if (totalExpertGb > 0) {
    const wanted = Math.min(overflow, totalExpertGb)
    models.forEach((m, i) => {
      const experts = expertGb[i]!
      if (experts <= 0) return
      const share = (wanted * experts) / totalExpertGb
      const layers = Math.min(m.layers, Math.ceil((m.layers * share) / experts))
      const moved = (experts * layers) / m.layers
      placements[i] = {
        ...placements[i]!,
        nCpuMoe: layers,
        gpuGb: placements[i]!.gpuGb - moved,
        ramGb: moved
      }
      overflow -= moved
    })
  }
  if (overflow > 0) {
    // Dense layers next: weights and their share of the KV cache move together.
    const dense = models
      .map((m, i) => ({
        m,
        i,
        layerGb: (m.weightsGb + kvGb(m, ctxSize, kv)) / Math.max(1, m.layers)
      }))
      .filter(({ m }) => !m.isMoe && m.layers > 0)
    const denseGb = dense.reduce((a, { m, layerGb }) => a + layerGb * m.layers, 0)
    if (denseGb > 0) {
      const wanted = Math.min(overflow, denseGb)
      for (const { m, i, layerGb } of dense) {
        const share = (wanted * layerGb * m.layers) / denseGb
        const off = Math.min(m.layers, Math.ceil(share / layerGb))
        const moved = off * layerGb
        placements[i] = {
          ...placements[i]!,
          nGpuLayers: m.layers - off,
          gpuGb: placements[i]!.gpuGb - moved,
          ramGb: moved
        }
        overflow -= moved
      }
    }
  }
  return { placements, gpuShortGb: Math.max(0, overflow) }
}

const round = (gb: number): number => Math.round(gb * 100) / 100

/**
 * Settings for every model to stay loaded at once, or a clear "won't fit". Tries the KV cache at
 * f16, then q8_0, then q4_0, and returns the first that fits the GPU and RAM budgets. Threads are
 * an even share of the usable cores, so their total never exceeds the CPU quota; more models than
 * cores does not fit.
 */
export function planKeepLoaded(
  machine: KeepLoadedMachine,
  models: KeepLoadedModel[],
  ctxSize = KEEP_LOADED_CTX_SIZE
): KeepLoadedPlan {
  const gpuBudgetGb =
    machine.gpuMemoryGb && machine.gpuMemoryGb > 0
      ? Math.max(0, machine.gpuMemoryGb - (machine.reservedGpuGb ?? 0) - GPU_FIT_MARGIN_GB)
      : 0
  const ramBudgetGb = Math.max(
    0,
    machine.totalRamGb * KEEP_LOADED_RAM_SHARE -
      (machine.reservedRamGb ?? 0) -
      KEEP_LOADED_RAM_RESERVE_GB
  )
  const threads = keepLoadedThreads(machine.usableCores, models.length)
  const base = { gpuBudgetGb: round(gpuBudgetGb), ramBudgetGb: round(ramBudgetGb) }

  let attempt: KeepLoadedPlan | null = null
  for (const kv of KV_ORDER) {
    const { placements, gpuShortGb } = place(models, ctxSize, kv, machine, gpuBudgetGb)
    const plans = models.map((m, i) => ({
      id: m.id,
      ...placements[i]!,
      gpuGb: round(placements[i]!.gpuGb),
      ramGb: round(placements[i]!.ramGb),
      ctxSize,
      kvCacheType: kv,
      threads,
      poll: 0 as const
    }))
    const gpuUsedGb = placements.reduce((a, p) => a + p.gpuGb, 0)
    const ramUsedGb = placements.reduce((a, p) => a + p.ramGb, 0)
    attempt = {
      ...base,
      fits: gpuShortGb <= 0 && ramUsedGb <= ramBudgetGb,
      models: plans,
      gpuUsedGb: round(gpuUsedGb),
      ramUsedGb: round(ramUsedGb),
      threadsTotal: threads * models.length
    }
    if (attempt.fits) break
  }
  const plan = attempt ?? {
    ...base,
    fits: true,
    models: [],
    gpuUsedGb: 0,
    ramUsedGb: 0,
    threadsTotal: 0
  }
  if (models.length > Math.max(1, Math.floor(machine.usableCores))) {
    return {
      ...plan,
      fits: false,
      reason: 'cpu',
      message: `${models.length} models need at least ${models.length} CPU cores; this machine allows ${Math.floor(machine.usableCores)}.`
    }
  }
  if (!plan.fits) {
    return {
      ...plan,
      reason: 'memory',
      message: 'These models do not fit in memory together. Remove one or pick smaller ones.'
    }
  }
  return plan
}

export interface KeepLoadedFiles {
  /** Absolute path of the main GGUF. */
  model: string
  /** Absolute path of the vision projector, when the model has one. */
  mmproj?: string | null
}

/** One INI value on one line: a newline would start a new key. */
function iniValue(value: string | number | boolean): string {
  return String(value).replace(/[\r\n]+/g, ' ')
}

/**
 * The name the router knows a kept model by. llama.cpp's preset reader rewrites what follows a
 * colon in a section name (it upper-cases "model-package-v1:0fd0…"), so a request naming the id
 * would not find it; colons become "--" here and the gateway names the model the same way.
 */
export function routerModelName(id: string): string {
  return id.replace(/[[\]]/g, '').replace(/:/g, '--')
}

/**
 * The router's preset file (llama-server --models-preset): one section per kept model, named by
 * routerModelName(id). Each loads at startup with one slot.
 */
export function keepLoadedPresetIni(
  plans: KeepLoadedModelPlan[],
  files: Record<string, KeepLoadedFiles>
): string {
  const lines = ['version = 1', '']
  for (const plan of plans) {
    const file = files[plan.id]
    if (!file) continue
    const keys: [string, string | number | boolean][] = [
      ['model', file.model],
      ...(file.mmproj ? ([['mmproj', file.mmproj]] as [string, string][]) : []),
      ['n-gpu-layers', plan.nGpuLayers],
      ...(plan.nCpuMoe > 0 ? ([['n-cpu-moe', plan.nCpuMoe]] as [string, number][]) : []),
      ['ctx-size', plan.ctxSize],
      ['cache-type-k', plan.kvCacheType],
      ['cache-type-v', plan.kvCacheType],
      ['threads', plan.threads],
      ['threads-batch', plan.threads],
      ['poll', plan.poll],
      ['parallel', 1],
      ['flash-attn', 'on'],
      ['jinja', true],
      ['load-on-startup', true]
    ]
    lines.push(`[${routerModelName(iniValue(plan.id))}]`)
    for (const [key, value] of keys) lines.push(`${key} = ${iniValue(value)}`)
    lines.push('')
  }
  return lines.join('\n')
}
