import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LLMService, SpeculativeDecodingMode } from '../../llm'
import { MTP_COMPANIONS, catalogEntryInstalled, visionStatus } from '../../models/catalog-logic'

const companion = MTP_COMPANIONS['unsloth/Qwen3.8-27B-GGUF']
const primary = 'Qwen3.8-27B-UD-Q4_K_M.gguf'

// A small GGUF metadata fixture on real disk. The sidecar is sparse, so its
// expected file size is faithful without allocating or reading model weights.
function gguf(file: string, embeddedMtp: boolean, size = 1024): void {
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
  const values = [Buffer.concat([str('general.architecture'), u32(8), str('qwen35')])]
  if (embeddedMtp) values.push(Buffer.concat([str('qwen35.nextn_predict_layers'), u32(4), u32(1)]))
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(values.length), ...values])
  )
  fs.truncateSync(file, size)
}

describe('MTP installation and persisted launch contract', () => {
  let profile: string
  const previousDataDir = process.env.OFFGRID_DATA_DIR

  beforeEach(() => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-mtp-'))
    fs.mkdirSync(path.join(profile, 'models'))
    process.env.OFFGRID_DATA_DIR = profile
  })

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
    else process.env.OFFGRID_DATA_DIR = previousDataDir
    fs.rmSync(profile, { recursive: true, force: true })
  })

  async function load(
    selected = primary,
    embeddedMtp = false,
    speculativeDecoding: SpeculativeDecodingMode = 'mtp'
  ): Promise<LLMService> {
    const models = path.join(profile, 'models')
    gguf(path.join(models, selected), embeddedMtp)
    const { importLocalModel, setActiveModel } = await import('../../models-manager')
    const imported = await importLocalModel(path.join(models, selected))
    expect(imported.success).toBe(true)
    expect((await setActiveModel(imported.id!)).success).toBe(true)
    const { LLMService } = await import('../../llm')
    const service = new LLMService()
    await service.pause()
    await service.setSettings(
      {
        speculativeDecoding,
        draftModel: 'unrelated.gguf',
        gpuLayers: 99,
        ctxSize: 8192,
        kvCacheType: 'q4_0',
        flashAttn: true
      },
      { emitSync: false }
    )
    return new LLMService()
  }

  it('loads the matching sidecar after restart and keeps the unrelated draft out of the engine', async () => {
    const sidecar = path.join(profile, 'models', companion.name)
    gguf(sidecar, true, companion.sizeBytes)
    const service = await load()
    expect(service.getSettings()).toMatchObject({ supportsMtp: true, speculativeDecoding: 'mtp' })
    const args = service.launchArgs()
    expect(args).toEqual(
      expect.arrayContaining(['--spec-type', 'draft-mtp', '--spec-draft-model', sidecar])
    )
    expect(args[args.indexOf('--spec-draft-n-max') + 1]).toBe('2')
    expect(args[args.indexOf('--spec-draft-ngl') + 1]).toBe('99')
    expect(args).not.toContain('unrelated.gguf')
  })

  it('keeps embedded MTP working without loading an unrelated or unnecessary draft', async () => {
    const service = await load(primary, true)
    expect(service.getSettings().supportsMtp).toBe(true)
    expect(service.launchArgs()).toContain('draft-mtp')
    expect(service.launchArgs()).not.toContain('--spec-draft-model')
  })

  it('uses the installed MTP companion even when the target also declares native heads', async () => {
    const sidecar = path.join(profile, 'models', companion.name)
    gguf(sidecar, true, companion.sizeBytes)
    const service = await load(primary, true)
    const args = service.launchArgs()
    expect(args[args.indexOf('--spec-draft-model') + 1]).toBe(sidecar)
  })

  it('does not apply the selected model MTP setting to a runtime specialist', async () => {
    const service = await load(primary, true)
    gguf(path.join(profile, 'models', 'specialist.gguf'), false)
    service.useRuntimeModel({ id: 'local:specialist', primary: 'specialist.gguf', mmproj: null })
    expect(service.launchArgs()).not.toContain('draft-mtp')
    service.restoreSelectedModel()
    expect(service.launchArgs()).toContain('draft-mtp')
  })

  it.each(['missing', 'truncated', 'no-head', 'wrong-model'])(
    'does not enable MTP for a %s companion',
    async (condition) => {
      if (condition !== 'missing') {
        gguf(
          path.join(profile, 'models', companion.name),
          condition !== 'no-head',
          condition === 'truncated' ? 1024 : companion.sizeBytes
        )
      }
      const service = await load(condition === 'wrong-model' ? 'Qwen3.5-9B-Q4_K_M.gguf' : primary)
      expect(service.getSettings()).toMatchObject({
        supportsMtp: false,
        speculativeDecoding: 'off'
      })
      expect(service.launchArgs()).not.toContain('draft-mtp')
    }
  )

  it('does not offer the Qwen MTP companion to Bonsai Prism', async () => {
    gguf(path.join(profile, 'models', companion.name), true, companion.sizeBytes)
    const service = await load('Ternary-Bonsai-2-27B-PQ2_0.gguf')
    expect(service.getSettings()).toMatchObject({ supportsMtp: false, speculativeDecoding: 'off' })
    expect(service.launchArgs()).not.toContain('--spec-type')
    expect(service.launchArgs()).not.toContain('--spec-draft-model')
  })

  it.each([primary, 'Ternary-Bonsai-2-27B-PQ2_0.gguf'])(
    'preserves N-gram decoding for %s without adding an MTP companion',
    async (selected) => {
      gguf(path.join(profile, 'models', companion.name), true, companion.sizeBytes)
      const service = await load(selected, false, 'ngram')
      expect(service.getSettings().speculativeDecoding).toBe('ngram')
      const args = service.launchArgs()
      expect(args[args.indexOf('--spec-type') + 1]).toBe('ngram-cache')
      expect(args).not.toContain('--spec-draft-model')
      expect(args).not.toContain('--spec-draft-n-max')
    }
  )

  it('offers companion repair while leaving the main model installed', async () => {
    const { desktopCatalog } = await import('../../models-manager')
    const entry = (await desktopCatalog()).find((model) => model.id === 'unsloth/Qwen3.8-27B-GGUF')!
    expect(entry.files.some((file) => file.name === companion.name && file.role === 'aux')).toBe(
      true
    )
    const present = (name: string): boolean => name !== companion.name
    expect(catalogEntryInstalled(entry, present, () => false)).toBe(true)
    expect(visionStatus(entry, present)).toMatchObject({ supportsMtp: true, mtpInstalled: false })
    expect(visionStatus(entry, () => true)).toMatchObject({ supportsMtp: true, mtpInstalled: true })
  })
})
