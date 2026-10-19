// GPU placement: Auto (the default) leaves layer and MoE-expert placement to llama-server's
// --fit, Manual passes the person's layer count. The real LLMService, settings file and launch
// ladder run over a temp profile; only the native engine is scripted (fixtures/placement-llama-server.mjs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LLMService } from '../../llm'

const FAKE_ENGINE = path.join(__dirname, 'fixtures', 'placement-llama-server.mjs')
// Bigger than the fake card's 8 GiB and than a Mac's Metal working set, without allocating it.
const TOO_BIG = Math.max(os.totalmem(), 16 * 1024 ** 3)

/** A GGUF header with an architecture and, for an MoE, an expert count. Sparse to `size`. */
function gguf(file: string, experts: number, size: number): void {
  const u32 = (value: number): Buffer => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32LE(value)
    return buffer
  }
  const u64 = (value: number): Buffer => {
    const buffer = Buffer.alloc(8)
    buffer.writeBigUInt64LE(BigInt(value))
    return buffer
  }
  const str = (value: string): Buffer =>
    Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)])
  const values = [Buffer.concat([str('general.architecture'), u32(8), str('qwen3moe')])]
  if (experts) values.push(Buffer.concat([str('qwen3moe.expert_count'), u32(4), u32(experts)]))
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(values.length), ...values])
  )
  fs.truncateSync(file, size)
}

describe('GPU placement at launch', () => {
  let profile: string
  let launchLog: string
  let service: LLMService | null = null
  const previous = {
    dataDir: process.env.OFFGRID_DATA_DIR,
    binDir: process.env.OFFGRID_BIN_DIR,
    log: process.env.PLACEMENT_LAUNCH_LOG
  }

  beforeEach(() => {
    profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-placement-')))
    fs.mkdirSync(path.join(profile, 'models'))
    const engineDir = path.join(profile, 'bin', 'llama')
    fs.mkdirSync(engineDir, { recursive: true })
    fs.copyFileSync(FAKE_ENGINE, path.join(engineDir, 'llama-server'))
    fs.chmodSync(path.join(engineDir, 'llama-server'), 0o755)
    launchLog = path.join(profile, 'launches.jsonl')
    process.env.OFFGRID_DATA_DIR = profile
    process.env.OFFGRID_BIN_DIR = path.join(profile, 'bin')
    process.env.PLACEMENT_LAUNCH_LOG = launchLog
  })

  afterEach(() => {
    service?.stop()
    service = null
    for (const [key, value] of [
      ['OFFGRID_DATA_DIR', previous.dataDir],
      ['OFFGRID_BIN_DIR', previous.binDir],
      ['PLACEMENT_LAUNCH_LOG', previous.log]
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(profile, { recursive: true, force: true })
  })

  async function activate(file: string, experts: number, size: number): Promise<LLMService> {
    gguf(path.join(profile, 'models', file), experts, size)
    const { importLocalModel, setActiveModel } = await import('../../models-manager')
    const imported = await importLocalModel(path.join(profile, 'models', file))
    expect(imported.success).toBe(true)
    expect((await setActiveModel(imported.id!)).success).toBe(true)
    const { LLMService } = await import('../../llm')
    return new LLMService()
  }

  const launches = (): string[][] =>
    fs.existsSync(launchLog)
      ? fs.readFileSync(launchLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      : []

  it('starts on Auto: no layer count, so llama-server places the layers itself', async () => {
    const owner = await activate('dense.gguf', 0, 1024)
    expect(owner.getSettings().gpuPlacement).toBe('auto')
    expect(owner.launchArgs()).not.toContain('-ngl')
  })

  it('passes the person\'s layer count under Manual and keeps it after a restart', async () => {
    const owner = await activate('dense.gguf', 0, 1024)
    await owner.pause()
    await owner.setSettings({ gpuPlacement: 'manual', gpuLayers: 20 }, { emitSync: false })
    const { LLMService } = await import('../../llm')
    const restarted = new LLMService()
    expect(restarted.getSettings()).toMatchObject({ gpuPlacement: 'manual', gpuLayers: 20 })
    const args = restarted.launchArgs()
    expect(args[args.indexOf('-ngl') + 1]).toBe('20')
  })

  it('keeps an older install\'s own layer count as Manual', async () => {
    fs.writeFileSync(
      path.join(profile, 'models', 'llm-settings.json'),
      JSON.stringify({ gpuLayers: 12 })
    )
    const owner = await activate('dense.gguf', 0, 1024)
    expect(owner.getSettings()).toMatchObject({ gpuPlacement: 'manual', gpuLayers: 12 })
  })

  it('gives an MoE too big for the GPU a 2048 batch under Auto, and falls back to the CPU last', async () => {
    service = await activate('moe-30b-a3b.gguf', 128, TOO_BIG)
    await service.init()

    const [gpu, cpu] = launches()
    // The GPU launch leaves placement to --fit and widens the batch for the experts on the CPU.
    expect(gpu).not.toContain('-ngl')
    expect(gpu![gpu!.indexOf('-b') + 1]).toBe('2048')
    expect(gpu![gpu!.indexOf('-ub') + 1]).toBe('2048')
    // It ran out of memory, so the ladder's last rung loaded the model on the CPU.
    expect(cpu![cpu!.indexOf('-ngl') + 1]).toBe('0')
    expect(launches()).toHaveLength(2)
    expect(service.isReady()).toBe(true)
    expect(service.getSettings().gpuOffload).toEqual({ layers: 0, total: 48 })
  })

  it('leaves the batch alone for a dense model of the same size and for an MoE that fits', async () => {
    const dense = await activate('dense-30b.gguf', 0, TOO_BIG)
    expect(dense.launchArgs()).not.toContain('-ub')
    fs.rmSync(path.join(profile, 'models', 'dense-30b.gguf'))
    const small = await activate('moe-small.gguf', 64, 1024)
    expect(small.launchArgs()).not.toContain('-ub')
  })

  it('keeps the person\'s own batch size over the MoE batch', async () => {
    const owner = await activate('moe-30b-a3b.gguf', 128, TOO_BIG)
    await owner.pause()
    await owner.setSettings({ batchSize: 512 }, { emitSync: false })
    const args = owner.launchArgs()
    expect(args[args.indexOf('-b') + 1]).toBe('512')
    expect(args).not.toContain('-ub')
  })
})
