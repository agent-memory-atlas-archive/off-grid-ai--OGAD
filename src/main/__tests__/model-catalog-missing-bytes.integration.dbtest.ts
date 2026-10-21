// A model whose shared files another model already brought shows only what is left to fetch. Real
// model manager and catalog over a temporary models folder; the files on disk are the only setup.
import { afterAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-missing-bytes-'))
process.env.OFFGRID_DATA_DIR = dataDir

const manager = await import('../models-manager')
const { CATALOG } = await import('@offgrid/models')

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('bytes left to download', () => {
  it('counts only the generator once Qwen-Image 2.1 Turbo brought the shared encoder, projector and VAE', async () => {
    const turbo = CATALOG.find((entry) => entry.id === 'offgrid-ai/Qwen-Image-2.1-Turbo-GGUF')!
    const base = CATALOG.find((entry) => entry.id === 'offgrid-ai/Qwen-Image-2.1-GGUF')!
    const models = path.join(dataDir, 'models')
    fs.mkdirSync(models, { recursive: true })
    // Turbo's companions are on disk; its generator and base's generator are not.
    for (const file of turbo.files.filter((file) => file.role !== 'primary')) {
      fs.writeFileSync(path.join(models, file.name), 'x')
    }

    const catalog = (await manager.getCatalog()).models as {
      id: string
      missingBytes?: number
    }[]
    const baseGenerator = base.files.find((file) => file.role === 'primary')!
    expect(catalog.find((model) => model.id === base.id)?.missingBytes).toBe(baseGenerator.sizeBytes)
    // A model with nothing on disk reports no figure: its full size is what it costs.
    const untouched = CATALOG.find((entry) => entry.id === 'offgrid-ai/juggernaut-xl-v9-GGUF')!
    expect(catalog.find((model) => model.id === untouched.id)?.missingBytes).toBeUndefined()
  })
})
