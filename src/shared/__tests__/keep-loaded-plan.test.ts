import { describe, expect, it } from 'vitest'
import {
  ALL_GPU_LAYERS,
  keepLoadedPresetIni,
  keepLoadedThreads,
  planKeepLoaded,
  type KeepLoadedMachine,
  type KeepLoadedModel
} from '../keep-loaded-plan'

// The RunPod RTX PRO 6000 the plan was proven on: 96 GB of VRAM, 1.5 TB of RAM, 128 cores seen
// but a 13.6-core CPU quota.
const pod: KeepLoadedMachine = {
  gpuMemoryGb: 96,
  unifiedMemory: false,
  totalRamGb: 1500,
  usableCores: 13
}

const moe = (id: string, weightsGb: number, mmprojGb = 0): KeepLoadedModel => ({
  id,
  weightsGb,
  mmprojGb,
  isMoe: true,
  layers: 48
})
const dense = (id: string, weightsGb: number, layers = 64): KeepLoadedModel => ({
  id,
  weightsGb,
  mmprojGb: 0,
  isMoe: false,
  layers
})

// Six models of the sizes kept loaded on the pod: one dense, five mixtures of experts.
const sixModels = [
  dense('qwen3.8-27b', 28),
  moe('minicpm-v-4.7', 36, 1),
  moe('flint', 26),
  moe('hy-memory', 32),
  moe('lfm2.5', 25),
  moe('sage-a1.5', 24)
]

describe('planKeepLoaded', () => {
  it('keeps six models on the pod by moving MoE experts to the CPU, two threads each', () => {
    const plan = planKeepLoaded(pod, sixModels)
    expect(plan.fits).toBe(true)
    expect(plan.reason).toBeUndefined()
    // The dense model stays whole on the GPU; every MoE moves some expert layers out.
    const byId = new Map(plan.models.map((m) => [m.id, m]))
    expect(byId.get('qwen3.8-27b')).toMatchObject({ nGpuLayers: ALL_GPU_LAYERS, nCpuMoe: 0 })
    for (const id of ['minicpm-v-4.7', 'flint', 'hy-memory', 'lfm2.5', 'sage-a1.5']) {
      expect(byId.get(id)!.nCpuMoe).toBeGreaterThan(0)
      expect(byId.get(id)!.nCpuMoe).toBeLessThan(48)
    }
    expect(plan.gpuUsedGb).toBeLessThanOrEqual(plan.gpuBudgetGb)
    // The threads stay inside the 13-core quota, and no engine busy-waits.
    expect(plan.models.every((m) => m.threads === 2 && m.poll === 0)).toBe(true)
    expect(plan.threadsTotal).toBeLessThanOrEqual(13)
    expect(plan.models.every((m) => m.ctxSize === 16_384)).toBe(true)
  })

  it('places everything on the GPU at f16 when the set fits', () => {
    const plan = planKeepLoaded(pod, [dense('a', 8, 32), moe('b', 12)])
    expect(plan.fits).toBe(true)
    expect(plan.models.every((m) => m.nGpuLayers === ALL_GPU_LAYERS && m.nCpuMoe === 0)).toBe(true)
    expect(plan.models.every((m) => m.kvCacheType === 'f16')).toBe(true)
    expect(plan.ramUsedGb).toBe(0)
  })

  it('moves whole layers of dense models to the CPU when there are no experts to move', () => {
    const plan = planKeepLoaded({ ...pod, gpuMemoryGb: 24 }, [
      dense('a', 16, 40),
      dense('b', 12, 40)
    ])
    expect(plan.fits).toBe(true)
    expect(plan.models.some((m) => m.nGpuLayers < 40)).toBe(true)
    expect(plan.gpuUsedGb).toBeLessThanOrEqual(plan.gpuBudgetGb)
    expect(plan.ramUsedGb).toBeGreaterThan(0)
  })

  it('quantizes the KV cache before giving up on unified memory', () => {
    // A 32 GB Mac: 24 GB of Metal working set. f16 at 16K does not fit two 8.5 GB models; q8_0 does.
    const mac: KeepLoadedMachine = {
      gpuMemoryGb: 24,
      unifiedMemory: true,
      totalRamGb: 32,
      usableCores: 10
    }
    const plan = planKeepLoaded(mac, [dense('a', 8.5, 36), dense('b', 8.5, 36)])
    expect(plan.fits).toBe(true)
    expect(plan.models.every((m) => m.kvCacheType === 'q8_0')).toBe(true)
    expect(plan.models.every((m) => m.nCpuMoe === 0 && m.nGpuLayers === ALL_GPU_LAYERS)).toBe(true)
  })

  it('says the set does not fit instead of planning an out-of-memory launch', () => {
    const plan = planKeepLoaded({ ...pod, gpuMemoryGb: 24, totalRamGb: 32 }, sixModels)
    expect(plan.fits).toBe(false)
    expect(plan.reason).toBe('memory')
    expect(plan.message).toMatch(/do not fit/)
    // The closest attempt is still there for the memory bar.
    expect(plan.models).toHaveLength(6)
    expect(plan.ramUsedGb).toBeGreaterThan(plan.ramBudgetGb)
  })

  it('does not fit more models than the CPU quota allows threads for', () => {
    const plan = planKeepLoaded({ ...pod, usableCores: 4 }, sixModels)
    expect(plan.fits).toBe(false)
    expect(plan.reason).toBe('cpu')
    expect(plan.message).toMatch(/6 models need at least 6 CPU cores/)
  })

  it('runs every model from RAM on a machine without a GPU', () => {
    const plan = planKeepLoaded(
      { gpuMemoryGb: null, unifiedMemory: false, totalRamGb: 64, usableCores: 16 },
      [dense('a', 5, 32), moe('b', 10)]
    )
    expect(plan.fits).toBe(true)
    expect(plan.models.every((m) => m.nGpuLayers === 0 && m.gpuGb === 0)).toBe(true)
    expect(plan.gpuBudgetGb).toBe(0)
    expect(plan.models.every((m) => m.threads === 8)).toBe(true)
  })

  it('leaves room for memory other engines already hold', () => {
    const alone = planKeepLoaded(pod, [moe('a', 40)])
    const beside = planKeepLoaded({ ...pod, reservedGpuGb: 60 }, [moe('a', 40)])
    expect(alone.models[0]!.nCpuMoe).toBe(0)
    expect(beside.gpuBudgetGb).toBe(alone.gpuBudgetGb - 60)
    expect(beside.models[0]!.nCpuMoe).toBeGreaterThan(0)
  })

  it('sizes the KV cache from the model shape when the header gives one', () => {
    const shape = { attentionLayers: 8, kvHeads: 4, keyDim: 256, valueDim: 256 }
    const plan = planKeepLoaded(pod, [{ ...dense('a', 4, 32), kvShape: shape }])
    // 16K tokens × 8 layers × 4 heads × (256 + 256) × 2 bytes = 0.5 GB, plus 4 GB and the 1.5 GB buffer.
    expect(plan.models[0]!.gpuGb).toBeCloseTo(6, 1)
  })

  it('plans nothing for an empty set', () => {
    const plan = planKeepLoaded(pod, [])
    expect(plan.fits).toBe(true)
    expect(plan.models).toEqual([])
    expect(plan.threadsTotal).toBe(0)
  })
})

describe('keepLoadedThreads', () => {
  it('shares the usable cores evenly, at least one and at most eight per model', () => {
    expect(keepLoadedThreads(13, 6)).toBe(2)
    expect(keepLoadedThreads(64, 2)).toBe(8)
    expect(keepLoadedThreads(2, 2)).toBe(1)
    expect(keepLoadedThreads(8, 0)).toBe(0)
  })
})

describe('keepLoadedPresetIni', () => {
  it('writes one section per model with the planned settings and the model files', () => {
    const plan = planKeepLoaded(pod, sixModels)
    const ini = keepLoadedPresetIni(plan.models, {
      'minicpm-v-4.7': { model: '/models/minicpm.gguf', mmproj: '/models/mmproj-minicpm.gguf' },
      'qwen3.8-27b': { model: '/models/qwen.gguf' }
    })
    const minicpm = plan.models.find((m) => m.id === 'minicpm-v-4.7')!
    expect(ini).toContain('version = 1')
    expect(ini).toContain(
      '[minicpm-v-4.7]\nmodel = /models/minicpm.gguf\nmmproj = /models/mmproj-minicpm.gguf'
    )
    expect(ini).toContain(`n-cpu-moe = ${minicpm.nCpuMoe}`)
    expect(ini).toContain(
      '[qwen3.8-27b]\nmodel = /models/qwen.gguf\nn-gpu-layers = 999\nctx-size = 16384'
    )
    expect(ini).toContain('threads = 2\nthreads-batch = 2\npoll = 0\nparallel = 1')
    expect(ini).toContain('load-on-startup = true')
    // A model with no files is left out.
    expect(ini).not.toContain('[flint]')
  })

  it('keeps every value on its own line', () => {
    const [plan] = planKeepLoaded(pod, [dense('a', 4, 32)]).models
    const ini = keepLoadedPresetIni([plan!], { a: { model: '/models/x\nmodel = /etc/passwd' } })
    expect(ini).toContain('model = /models/x model = /etc/passwd')
    expect(ini.split('\n').filter((line) => line.startsWith('model ='))).toHaveLength(1)
  })
})
