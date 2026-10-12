import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureRuntime, modelsDir } from '../runtime-env'
import { addModelScanFolder, removeModelScanFolder } from '../model-storage-choice'
import { modelReadDirectories, resolveModelAsset, resolveModelPackage } from '../model-paths'
import { ActiveModalityStore, getActiveModal } from '../active-models'
import { listImageModels, resolveTaesd } from '../imagegen'
import { whisperModel, smallWhisperModel } from '../transcription/whisper-cli'
import { CATALOG } from '@offgrid/models'
import { listInstalled, deleteModel, activateModel } from '../models-manager'
import { taesdFilename } from '../../shared/image-defaults'

let profile: string
let oldRoot: string
let newRoot: string
function asset(root: string, name: string, value = 'synthetic model fixture'): string {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
  return fs.realpathSync(file)
}
beforeEach(() => {
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-folder-fallback-'))
  oldRoot = path.join(profile, 'old')
  newRoot = path.join(profile, 'new')
  fs.mkdirSync(oldRoot)
  fs.mkdirSync(newRoot)
  configureRuntime({ dataDir: profile, modelsDir: newRoot })
  addModelScanFolder(profile, oldRoot)
})
afterEach(() => {
  configureRuntime({ dataDir: undefined, modelsDir: undefined })
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('models left in their previous folder', () => {
  it('lists catalog media from the old folder, activates it, and refuses to delete its files', async () => {
    for (const kind of ['image', 'voice', 'transcription']) {
      const entry = CATALOG.find(
        (model) => model.kind === kind && model.files.length > 0 && model.runtime !== 'mflux'
      )!
      expect(entry).toBeDefined()
      for (const file of entry.files) asset(oldRoot, file.name)
      expect(await listInstalled()).toContain(entry.id)
      expect(await activateModel(entry.id)).toEqual({ success: true })
      expect(await deleteModel(entry.id)).toMatchObject({ success: false })
      for (const file of entry.files)
        expect(fs.existsSync(path.join(oldRoot, file.name))).toBe(true)
    }
  })

  it('keeps image and transcription models available after changing the base folder', () => {
    asset(oldRoot, 'dreamshaper-xl-v2-turbo-Q8_0.gguf')
    const tiny = asset(oldRoot, 'ggml-tiny.bin')
    const large = asset(oldRoot, 'ggml-large-v3-turbo.bin')
    const decoderName = taesdFilename('dreamshaper-xl-v2-turbo-Q8_0.gguf')
    const decoder = asset(oldRoot, decoderName)
    expect(listImageModels()).toContain('dreamshaper-xl-v2-turbo-Q8_0.gguf')
    expect(whisperModel()).toBe(large)
    expect(smallWhisperModel()).toBe(tiny)
    expect(resolveTaesd('dreamshaper-xl-v2-turbo-Q8_0.gguf')).toBe(decoder)
    expect(modelsDir()).toBe(newRoot)
    expect(fs.readdirSync(newRoot)).toEqual([])
  })

  it('preserves selected modalities and saves later choices only in the new folder', () => {
    const old = new ActiveModalityStore(() => oldRoot)
    old.set('image', 'dreamshaper-xl-v2-turbo-Q8_0.gguf')
    old.set('transcription', 'ggml-tiny.bin')
    asset(oldRoot, 'ggml-tiny.bin')
    asset(oldRoot, 'ggml-large-v3-turbo.bin')
    expect(whisperModel()).toBe(fs.realpathSync(path.join(oldRoot, 'ggml-tiny.bin')))
    const current = new ActiveModalityStore()
    current.set('speech', 'kokoro')
    expect(getActiveModal('image')).toBe(old.get('image'))
    current.set('image', null)
    expect(getActiveModal('image')).toBeNull()
    expect(old.get('image')).toBe('dreamshaper-xl-v2-turbo-Q8_0.gguf')
    expect(old.get('speech')).toBeNull()
  })

  it('gives the new folder priority and removes only the old folder reference', () => {
    asset(oldRoot, 'ggml-base.bin', 'old')
    const newer = asset(newRoot, 'ggml-base.bin', 'new')
    expect(resolveModelAsset('ggml-base.bin')).toBe(newer)
    removeModelScanFolder(profile, fs.realpathSync(oldRoot))
    expect(modelReadDirectories()).toEqual([newRoot])
    expect(fs.readFileSync(path.join(oldRoot, 'ggml-base.bin'), 'utf8')).toBe('old')
  })

  it('uses a complete voice package and does not mix partial installations', () => {
    const names = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_fp16.onnx']
    const oldCache = path.join(oldRoot, '.cache/onnx-community/Kokoro-82M-v1.0-ONNX')
    const newCache = path.join(newRoot, '.cache/onnx-community/Kokoro-82M-v1.0-ONNX')
    for (const name of names) asset(oldCache, name)
    asset(newCache, names[0]!)
    expect(resolveModelPackage(names, [newCache, oldCache])).toBe(fs.realpathSync(oldCache))
    fs.unlinkSync(path.join(oldCache, names[0]!))
    expect(resolveModelPackage(names, [newCache, oldCache])).toBeNull()
  })

  it('ignores a missing drive and rejects traversal and links outside the folder', () => {
    const secret = asset(profile, 'outside.bin')
    fs.symlinkSync(secret, path.join(oldRoot, 'linked.bin'))
    expect(resolveModelAsset('linked.bin')).toBeNull()
    expect(resolveModelAsset('../outside.bin')).toBeNull()
    expect(resolveModelAsset('..\\outside.bin')).toBeNull()
    expect(resolveModelAsset(secret)).toBeNull()
    fs.rmSync(oldRoot, { recursive: true })
    const available = asset(newRoot, 'ggml-base.bin')
    expect(whisperModel()).toBe(available)
    expect(fs.existsSync(oldRoot)).toBe(false)
  })
})
