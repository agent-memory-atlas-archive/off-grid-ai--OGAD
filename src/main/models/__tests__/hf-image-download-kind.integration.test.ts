// A Hugging Face image repository downloaded from search (not the curated catalog) must be an
// image model everywhere: Storage, the Image tab's "On this device", image activation and the
// image runtime, and never a chat model. The search result carries no kind, so the download used
// to be recorded as 'text' and only the filename-based image runtime saw it as an image model.
//
// Only boundaries outside Off Grid AI are controlled: HTTP (the Hugging Face API and file
// downloads) serves small deterministic bytes, a tiny executable stands in for sd-cli, and a temp
// directory is the profile. Download, registry, catalog merge, storage, activation and the image
// runtime's model listing all run for real.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const originalDataDir = process.env.OFFGRID_DATA_DIR
const originalBinDir = process.env.OFFGRID_BIN_DIR
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-hf-image-kind-'))
const dataDir = path.join(testRoot, 'data')
const binDir = path.join(testRoot, 'bin')
const modelsDir = path.join(dataDir, 'models')
process.env.OFFGRID_DATA_DIR = dataDir
process.env.OFFGRID_BIN_DIR = binDir

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: {
    getPath: () => dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const manager = await import('../../models-manager')
const { installedTextModelEntries } = await import('../../model-server/models-list')
const { modelShowsOnTab } = await import('../../../shared/model-settings-rules')

const IMAGE_REPO = 'unsloth/Qwen-Image-2.1-Turbo-GGUF'
const IMAGE_FILE = 'qwen-image-2.1-turbo-Q4_K_M.gguf'
const TEXT_REPO = 'bartowski/Llama-3.2-3B-Instruct-GGUF'
const TEXT_FILE = 'Llama-3.2-3B-Instruct-Q4_K_M.gguf'
// A chat model whose name carries a word the image-family filename check also uses.
const TURBO_CHAT_REPO = 'example/Llama-3.1-Turbo-8B-Instruct-GGUF'
const TURBO_CHAT_FILE = 'Llama-3.1-Turbo-8B-Instruct-Q4_K_M.gguf'

const ggufBytes = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.concat([Buffer.from('GGUF', 'ascii'), Buffer.alloc(2_044, 7)]))

/** A GGUF v3 header as llama.cpp writes it for a chat model: architecture and trained context. */
function chatGgufBytes(): Uint8Array<ArrayBuffer> {
  const str = (value: string): Buffer => {
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(Buffer.byteLength(value)))
    return Buffer.concat([length, Buffer.from(value, 'utf8')])
  }
  const u32 = (value: number): Buffer => {
    const out = Buffer.alloc(4)
    out.writeUInt32LE(value)
    return out
  }
  const u64 = (value: number): Buffer => {
    const out = Buffer.alloc(8)
    out.writeBigUInt64LE(BigInt(value))
    return out
  }
  const header = Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(3),
    u64(0),
    u64(2),
    str('general.architecture'),
    u32(8),
    str('llama'),
    str('llama.context_length'),
    u32(4),
    u32(131_072)
  ])
  return new Uint8Array(Buffer.concat([header, Buffer.alloc(2_048 - header.length, 0)]))
}

/** Hugging Face as seen over HTTP: one repo listing, and the weight file it names. */
function huggingFaceServes(repoId: string, fileName: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes(`/api/models/${repoId}`)) {
        return new Response(JSON.stringify({ siblings: [{ rfilename: fileName, size: 2048 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (url.endsWith(fileName)) {
        return new Response(ggufBytes(), {
          status: 200,
          headers: { 'content-length': '2048' }
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
  )
}

async function catalogModel(
  id: string
): Promise<{ id: string; name: string; kind: string } | undefined> {
  const { models } = await manager.getCatalog()
  return (models as Array<{ id: string; name: string; kind: string }>).find((m) => m.id === id)
}

async function chatModelIds(): Promise<string[]> {
  const { models } = await manager.getCatalog()
  return installedTextModelEntries(
    models as Array<{ id: string; name: string; kind: string }>,
    await manager.listInstalled(),
    0
  ).map((entry) => entry.id as string)
}

beforeAll(() => {
  fs.mkdirSync(modelsDir, { recursive: true })
  const sdCli = path.join(binDir, 'sd', 'sd-cli')
  fs.mkdirSync(path.dirname(sdCli), { recursive: true })
  fs.writeFileSync(sdCli, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  // Each test starts from an empty models folder; the profile is this test's temp directory.
  for (const id of [IMAGE_REPO, TEXT_REPO, TURBO_CHAT_REPO]) await manager.clearDownload(id)
  for (const name of [
    IMAGE_FILE,
    TEXT_FILE,
    TURBO_CHAT_FILE,
    'downloaded-models.json',
    'active-model.json',
    'active-modalities.json'
  ]) {
    fs.rmSync(path.join(modelsDir, name), { force: true })
  }
})

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  if (originalBinDir === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = originalBinDir
  fs.rmSync(testRoot, { recursive: true, force: true })
})

describe('a Hugging Face image model downloaded from search', () => {
  it('is an image model in Storage and on the Image tab, and never a chat model', async () => {
    huggingFaceServes(IMAGE_REPO, IMAGE_FILE)

    expect(await manager.downloadModel(IMAGE_REPO)).toEqual({ success: true })

    expect(await manager.listInstalled()).toContain(IMAGE_REPO)
    const storage = (await manager.getStorageInfo()).models.find((m) => m.id === IMAGE_REPO)
    expect(storage?.kind).toBe('image')

    const model = await catalogModel(IMAGE_REPO)
    expect(model?.kind).toBe('image')
    expect(modelShowsOnTab(model!, 'image')).toBe(true)
    expect(modelShowsOnTab(model!, 'text')).toBe(false)
    expect(await chatModelIds()).not.toContain(IMAGE_REPO)
  })

  it('is used by the image runtime when selected from the Image tab', async () => {
    huggingFaceServes(IMAGE_REPO, IMAGE_FILE)
    expect(await manager.downloadModel(IMAGE_REPO)).toEqual({ success: true })

    expect(await manager.activateModel(IMAGE_REPO, 'image')).toEqual({ success: true })

    expect(manager.getActiveModalities().image).toBe(IMAGE_FILE)
    expect(manager.getActiveModalities().text).toBeNull()
    const { imageGenStatus } = await import('../../imagegen')
    expect(imageGenStatus()).toMatchObject({ available: true, active: IMAGE_FILE })
    expect(imageGenStatus().models).toContain(IMAGE_FILE)
    const storage = (await manager.getStorageInfo()).models.find((m) => m.id === IMAGE_REPO)
    expect(storage).toMatchObject({ kind: 'image', active: true })
  })

  it('repairs a download an older build recorded as a text model', async () => {
    // The exact registry shape found on an affected install.
    fs.writeFileSync(path.join(modelsDir, IMAGE_FILE), ggufBytes())
    fs.writeFileSync(
      path.join(modelsDir, 'downloaded-models.json'),
      JSON.stringify([
        {
          id: IMAGE_REPO,
          name: 'Qwen-Image-2.1-Turbo-GGUF',
          kind: 'text',
          files: [IMAGE_FILE]
        }
      ])
    )

    const storage = (await manager.getStorageInfo()).models.find((m) => m.id === IMAGE_REPO)
    expect(storage?.kind).toBe('image')
    expect((await catalogModel(IMAGE_REPO))?.kind).toBe('image')
    expect(await chatModelIds()).not.toContain(IMAGE_REPO)
    // The role is judged on read; the recorded entry is left as the user's data.
    const registry = JSON.parse(
      fs.readFileSync(path.join(modelsDir, 'downloaded-models.json'), 'utf8')
    ) as Array<{ id: string; kind: string }>
    expect(registry.find((m) => m.id === IMAGE_REPO)?.kind).toBe('text')
  })

  it('keeps a chat model named "turbo" a chat model, and records it as one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.includes(`/api/models/${TURBO_CHAT_REPO}`)) {
          return new Response(
            JSON.stringify({ siblings: [{ rfilename: TURBO_CHAT_FILE, size: 2048 }] }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        if (url.endsWith(TURBO_CHAT_FILE)) {
          return new Response(chatGgufBytes(), {
            status: 200,
            headers: { 'content-length': '2048' }
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      })
    )

    expect(await manager.downloadModel(TURBO_CHAT_REPO)).toEqual({ success: true })

    const storage = (await manager.getStorageInfo()).models.find((m) => m.id === TURBO_CHAT_REPO)
    expect(storage?.kind).toBe('text')
    expect(modelShowsOnTab((await catalogModel(TURBO_CHAT_REPO))!, 'image')).toBe(false)
    expect(await chatModelIds()).toContain(TURBO_CHAT_REPO)
    const registry = JSON.parse(
      fs.readFileSync(path.join(modelsDir, 'downloaded-models.json'), 'utf8')
    ) as Array<{ id: string; kind: string }>
    expect(registry.find((m) => m.id === TURBO_CHAT_REPO)?.kind).toBe('text')
  })

  it('corrects a chat model an earlier build saved as an image model, without rewriting it', async () => {
    // The registry shape the filename guess left behind on an affected install.
    fs.writeFileSync(path.join(modelsDir, TURBO_CHAT_FILE), chatGgufBytes())
    const recorded = JSON.stringify([
      {
        id: TURBO_CHAT_REPO,
        name: 'Llama-3.1-Turbo-8B-Instruct-GGUF',
        kind: 'image',
        files: [TURBO_CHAT_FILE]
      }
    ])
    fs.writeFileSync(path.join(modelsDir, 'downloaded-models.json'), recorded)

    const storage = (await manager.getStorageInfo()).models.find((m) => m.id === TURBO_CHAT_REPO)
    expect(storage?.kind).toBe('text')
    expect(await chatModelIds()).toContain(TURBO_CHAT_REPO)
    expect(fs.readFileSync(path.join(modelsDir, 'downloaded-models.json'), 'utf8')).toBe(recorded)
  })

  it('leaves a chat model downloaded from search as a chat model', async () => {
    huggingFaceServes(TEXT_REPO, TEXT_FILE)

    expect(await manager.downloadModel(TEXT_REPO)).toEqual({ success: true })

    const storage = (await manager.getStorageInfo()).models.find((m) => m.id === TEXT_REPO)
    expect(storage?.kind).toBe('text')
    expect(modelShowsOnTab((await catalogModel(TEXT_REPO))!, 'image')).toBe(false)
    expect(await chatModelIds()).toContain(TEXT_REPO)
  })
})
