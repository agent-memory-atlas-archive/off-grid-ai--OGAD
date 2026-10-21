// A size picked in the Models panel is the size that loads. Real model manager, registry and
// activation over a temporary models folder; Hugging Face (its file list and the file bytes) is
// the only boundary fake.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-chosen-size-'))
process.env.OFFGRID_DATA_DIR = dataDir

const manager = await import('../models-manager')
const { CATALOG } = await import('@offgrid/models')

const entry = CATALOG.find(
  (model) =>
    model.kind === 'text' &&
    model.files.length === 1 &&
    /\.gguf$/i.test(model.files[0]!.name) &&
    !model.files[0]!.sha256
)
if (!entry) throw new Error('The catalog needs a single-file text model')
const defaultFile = entry.files[0]!.name
const stem = defaultFile.replace(/-?[A-Z0-9_]+\.gguf$/i, '')
const smaller = `${stem}-Q3_K_M.gguf`
const larger = `${stem}-Q8_0.gguf`
const gguf = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 3)])
const modelsDir = path.join(dataDir, 'models')

function huggingFace(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/api/models/')) {
        return new Response(
          JSON.stringify({
            id: entry!.id,
            siblings: [defaultFile, smaller, larger].map((rfilename) => ({
              rfilename,
              size: gguf.length
            }))
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      return new Response(gguf, { status: 200, headers: { 'content-length': String(gguf.length) } })
    })
  )
}

function activePrimary(): string {
  return JSON.parse(fs.readFileSync(path.join(modelsDir, 'active-model.json'), 'utf8')).primary
}

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(modelsDir, { recursive: true, force: true })
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('a chosen size', () => {
  it('reports the installed package on completion, and activating it loads that size', async () => {
    huggingFace()
    let installedId: string | undefined
    const result = await manager.downloadModel(
      entry.id,
      (progress) => {
        if (progress.status === 'completed') installedId = progress.installedId
      },
      smaller
    )

    expect(result).toEqual({ success: true })
    expect(installedId).toBeDefined()
    expect(installedId).not.toBe(entry.id)
    expect((await manager.activateModel(installedId!)).success).toBe(true)
    expect(activePrimary()).toBe(smaller)
  })

  it('loads the newest of two downloaded sizes when the model is chosen by its family', async () => {
    huggingFace()
    await manager.downloadModel(entry.id, undefined, smaller)
    await manager.downloadModel(entry.id, undefined, larger)

    expect((await manager.activateModel(entry.id)).success).toBe(true)
    expect(activePrimary()).toBe(larger)
  })
})
