import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configureRuntime } from '../runtime-env'
import { addModelScanFolder } from '../model-storage-choice'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({ pipeline: vi.fn() }))
vi.mock('@huggingface/transformers', () => ({ pipeline: host.pipeline }))
vi.mock('../embeddings-env', () => ({ configureTransformersEnv: vi.fn() }))
vi.mock('../onnx-device', () => ({
  onnxDeviceCandidates: () => ['cpu'],
  loadWithOnnxFallback: async (load: (device: string) => Promise<unknown>) => ({
    runtime: await load('cpu'),
    device: 'cpu'
  })
}))

import { disposeEmbeddingModel, embedText } from '../embeddings-core'

let profile: string
let selected: string
beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-embedding-fallback-'))
  selected = path.join(profile, 'models')
  fs.mkdirSync(selected)
  configureRuntime({ dataDir: profile, modelsDir: selected })
})
afterEach(async () => {
  await disposeEmbeddingModel()
  host.pipeline.mockReset()
  configureRuntime({ dataDir: undefined, modelsDir: undefined })
  fs.rmSync(profile, { recursive: true, force: true })
})

it('retries an embedding model load after a temporary provider failure', async () => {
  const runtime = Object.assign(
    vi.fn(async () => ({ data: new Float32Array([0.25, 0.5]) })),
    { dispose: vi.fn() }
  )
  host.pipeline.mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValue(runtime)

  await expect(embedText('first', selected)).rejects.toThrow('provider unavailable')
  await expect(embedText('second', selected)).resolves.toEqual([0.25, 0.5])
  expect(host.pipeline).toHaveBeenCalledTimes(2)
})

it('loads embeddings from a scan folder while the chosen folder is offline', async () => {
  const scan = path.join(profile, 'scan')
  const packageRoot = path.join(scan, '.cache/Xenova/all-MiniLM-L6-v2')
  for (const name of [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'onnx/model.onnx'
  ]) {
    const file = path.join(packageRoot, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'synthetic model data')
  }
  addModelScanFolder(profile, scan)
  fs.rmdirSync(selected)
  host.pipeline.mockResolvedValue(
    Object.assign(
      vi.fn(async () => ({ data: new Float32Array([0.25, 0.5]) })),
      { dispose: vi.fn() }
    )
  )
  const { embeddings } = await import('../embeddings')
  await expect(embeddings.generateEmbedding('memory query')).resolves.toEqual([0.25, 0.5])
  expect(host.pipeline).toHaveBeenCalledWith('feature-extraction', fs.realpathSync(packageRoot), {
    device: 'cpu',
    local_files_only: true
  })
  expect(fs.existsSync(selected)).toBe(false)
})

it('refuses an embedding download when no complete package exists and storage is offline', async () => {
  fs.rmdirSync(selected)
  await expect(embedText('query', selected)).rejects.toThrow(
    'Connect the drive or choose another folder.'
  )
  expect(host.pipeline).not.toHaveBeenCalled()
  expect(fs.existsSync(selected)).toBe(false)
})
