// PageOcrPort: reads scanned PDF pages.
//
// - Apple Vision (the shipped helper, PDF mode) on macOS for Latin and CJK text: measured ~0.2–0.5 s
//   a page. Vision supports no Indian script.
// - PaddleOCR (@gutenye/ocr-node on our ONNX Runtime) for documents in an Indian script, and on
//   Windows and Linux. Its bundled models read English and Chinese; the official PaddlePaddle
//   Devanagari PP-OCRv5 recognizer (Apache-2.0) downloads on first use for Hindi, Marathi, Nepali.

import fs from 'node:fs'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { Worker } from 'worker_threads'
import { createRequire } from 'node:module'
import type { DocumentPage, PageOcrPort } from '@offgrid/rag/documents'
import { modelsDir } from '../runtime-env'
import { withStorageDownload } from '../model-storage-guard'
import { runPdfOCR, visionOcrAvailable } from '../ocr'
import { documentStore } from './sqlite-store'
import type { PaddleModels } from './ocr-paddle-core'
import type { OcrWorkerRequest, OcrWorkerResponse } from './ocr-worker'

const DEVANAGARI_REPO =
  'https://huggingface.co/PaddlePaddle/devanagari_PP-OCRv5_mobile_rec_onnx/resolve/main'
const DEVANAGARI = /[ऀ-ॿ]/g

/** Does the readable part of this document use an Indian script? */
async function usesIndicScript(documentId: string): Promise<boolean> {
  const pages = await documentStore.readPages(documentId)
  let indic = 0
  let letters = 0
  for (const page of pages) {
    if (page.needsOcr) continue
    indic += page.text.match(DEVANAGARI)?.length ?? 0
    letters += page.text.replace(/\s+/g, '').length
    if (letters > 20_000) break
  }
  return letters > 0 && indic / letters > 0.2
}

/** The character list from PaddleOCR's inference.yml (`PostProcess.character_dict`). */
function characterDictionary(yml: string): string[] {
  const lines = yml.split('\n')
  const start = lines.findIndex((line) => /^\s*character_dict:\s*$/.test(line))
  if (start < 0) return []
  const indent = lines[start]!.search(/\S/)
  const chars: string[] = []
  for (const line of lines.slice(start + 1)) {
    const match = /^(\s*)-\s?(.*)$/.exec(line)
    if (!match || match[1]!.length < indent) break
    let value = match[2]!
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1).replace(/''/g, "'")
    }
    chars.push(value)
  }
  return chars
}

/**
 * The English/Chinese models bundled with @gutenye/ocr-models. ONNX Runtime opens model files by
 * path natively, which cannot read inside app.asar, so the packaged copies come from
 * app.asar.unpacked (electron-builder.yml unpacks them).
 */
async function bundledModels(): Promise<PaddleModels> {
  const assets = path.join(
    path.dirname(createRequire(__filename).resolve('@gutenye/ocr-models/node')),
    'assets'
  )
  const unpacked = (file: string): string =>
    file.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  return {
    detectionPath: unpacked(path.join(assets, 'ch_PP-OCRv4_det_infer.onnx')),
    recognitionPath: unpacked(path.join(assets, 'ch_PP-OCRv4_rec_infer.onnx')),
    dictionaryPath: unpacked(path.join(assets, 'ppocr_keys_v1.txt'))
  }
}

let devanagariModels: Promise<PaddleModels> | null = null

/** Bundled detection model + the Devanagari recognizer, downloaded once into the models folder. */
function ensureDevanagariModels(): Promise<PaddleModels> {
  devanagariModels ??= withStorageDownload(async () => {
    const dir = path.join(modelsDir(), 'ocr', 'devanagari_PP-OCRv5_mobile_rec')
    const recognitionPath = path.join(dir, 'inference.onnx')
    const dictionaryPath = path.join(dir, 'dict.txt')
    if (!existsSync(recognitionPath) || !existsSync(dictionaryPath)) {
      await fs.promises.mkdir(dir, { recursive: true })
      const yml = await (await fetch(`${DEVANAGARI_REPO}/inference.yml`)).text()
      const chars = characterDictionary(yml)
      if (chars.length < 50) throw new Error('The Devanagari OCR dictionary could not be read.')
      const response = await fetch(`${DEVANAGARI_REPO}/inference.onnx`)
      if (!response.ok)
        throw new Error(`Downloading the Devanagari OCR model failed (${response.status}).`)
      const temp = `${recognitionPath}.part`
      await fs.promises.writeFile(temp, Buffer.from(await response.arrayBuffer()))
      await fs.promises.rename(temp, recognitionPath)
      // No trailing newline: the recognizer maps line N to class N + 1.
      await fs.promises.writeFile(dictionaryPath, chars.join('\n'))
    }
    return { detectionPath: (await bundledModels()).detectionPath, recognitionPath, dictionaryPath }
  })
  devanagariModels.catch(() => {
    devanagariModels = null
  })
  return devanagariModels
}

function builtWorkerEntry(): string | null {
  for (const dir of [__dirname, path.join(__dirname, '..')]) {
    const built = path.join(dir, 'documents-ocr-worker.js')
    if (existsSync(built)) return built
  }
  return null
}

let worker: Worker | null = null
let nextId = 1
const jobs = new Map<
  number,
  { resolve: (pages: { page: number; text: string }[]) => void; reject: (e: Error) => void }
>()

function ocrWorker(entry: string): Worker {
  if (worker) return worker
  const created = new Worker(entry, { resourceLimits: { maxOldGenerationSizeMb: 3072 } })
  created.on('message', (response: OcrWorkerResponse) => {
    const job = jobs.get(response.id)
    if (!job) return
    jobs.delete(response.id)
    if (response.error !== undefined) job.reject(new Error(response.error))
    else job.resolve(response.pages ?? [])
  })
  const fail = (error: Error): void => {
    if (worker !== created) return
    worker = null
    for (const job of jobs.values()) job.reject(error)
    jobs.clear()
  }
  created.on('error', fail)
  created.on('exit', (code) =>
    code !== 0 ? fail(new Error(`OCR stopped (exit ${code})`)) : (worker = null)
  )
  created.unref()
  worker = created
  return created
}

async function paddle(
  pdfPath: string,
  pages: number[],
  models: PaddleModels | null
): Promise<{ page: number; text: string }[]> {
  const entry = builtWorkerEntry()
  if (!entry) {
    const { paddleOcrPages } = await import('./ocr-paddle-core')
    return paddleOcrPages(pdfPath, pages, models)
  }
  const id = nextId++
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject })
    ocrWorker(entry).postMessage({ id, pdfPath, pages, models } satisfies OcrWorkerRequest)
  })
}

export const pageOcr: PageOcrPort = {
  async recognize(source, pages, options) {
    if (source.kind !== 'pdf' || !source.path || !pages.length) return []
    const indic = await usesIndicScript(source.id)
    let read: { page: number; text: string }[]
    if (!indic && visionOcrAvailable()) {
      const result = await runPdfOCR(source.path, pages, { signal: options.signal, parallel: 2 })
      read = pages.map((page) => ({ page, text: result.get(page) ?? '' }))
    } else {
      read = await paddle(
        source.path,
        pages,
        indic ? await ensureDevanagariModels() : await bundledModels()
      )
    }
    const out: DocumentPage[] = read.map(({ page, text }) => ({ page, text }))
    for (const page of out) options.onPage?.(page)
    return out
  }
}

export async function shutdownOcr(): Promise<void> {
  const current = worker
  worker = null
  for (const job of jobs.values()) job.reject(new Error('Shutting down.'))
  jobs.clear()
  await current?.terminate()
}
