// The downloader's disk rules through the real model manager over a temporary models folder. Network
// delivery is the only boundary fake; the free-space reading, partial files, verification and
// promotion are real. A DB journey, because models-manager's coverage is measured in this suite.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-disk-'))
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
const target = { entry, filePath: path.join(dataDir, 'models', entry.files[0]!.name) }

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(target.filePath, { force: true })
  fs.rmSync(`${target.filePath}.part`, { force: true })
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('model download disk rules', () => {
  it('starts over when a kept partial file is already whole, instead of asking for a range past its end', async () => {
    // A download cancelled after its last byte keeps a complete .part. Asking the server for
    // bytes past the end gets 416 on every retry; the downloader must start the file again.
    const expected = target.entry.files[0]!.sizeBytes!
    fs.mkdirSync(path.dirname(target.filePath), { recursive: true })
    fs.writeFileSync(`${target.filePath}.part`, '')
    fs.truncateSync(`${target.filePath}.part`, expected)
    const complete = Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_000, 5)])
    const ranges: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input, init?: RequestInit) => {
        ranges.push(new Headers(init?.headers).get('range'))
        return new Response(complete, {
          status: 200,
          headers: { 'content-length': String(complete.length) }
        })
      })
    )

    const result = await manager.downloadModel(target.entry.id)

    expect(result).toEqual({ success: true })
    expect(ranges.every((range) => range === null)).toBe(true)
    expect(fs.readFileSync(target.filePath)).toEqual(complete)
  })

  it('refuses a file the folder cannot hold before writing a byte, and says so in words', async () => {
    // A server that reports a petabyte: the real free space on this volume cannot hold it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(Buffer.from('GGUF'))
          }
        })
        return new Response(body, { status: 200, headers: { 'content-length': String(1e15) } })
      })
    )

    const result = await manager.downloadModel(target.entry.id)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^Not enough disk space\. .+ needs 1000000\.0 GB and [\d.]+ GB is free\.$/)
    // Nothing was written: no partial file to clean up.
    expect(fs.existsSync(`${target.filePath}.part`)).toBe(false)
  })

})
