// ExtractPort adapter: runs extraction in the documents worker (built beside index.js), or
// in-process when running from source, using the same implementation either way.

import path from 'path'
import { existsSync } from 'fs'
import { Worker } from 'worker_threads'
import type { DocumentPage, DocumentSource, ExtractPort } from '@offgrid/rag/documents'
import { ExtractionError, extractDocument } from './extract-core'
import type { ExtractWorkerRequest, ExtractWorkerResponse } from './extract-worker'

/**
 * The built worker sits beside index.js in out/main. This module may be bundled into a chunk one
 * folder deeper (code splitting), so both folders are tried rather than trusting this chunk's
 * __dirname alone.
 */
function builtWorkerEntry(): string | null {
  for (const dir of [__dirname, path.join(__dirname, '..')]) {
    const built = path.join(dir, 'documents-extract-worker.js')
    if (existsSync(built)) return built
  }
  return null
}

class DocumentExtractor implements ExtractPort {
  private worker: Worker | null = null
  private nextId = 1
  private readonly jobs = new Map<
    number,
    {
      onPages: (pages: DocumentPage[]) => void
      resolve: (value: { pageCount: number }) => void
      reject: (error: Error) => void
    }
  >()

  private spawn(entry: string): Worker {
    if (this.worker) return this.worker
    // pdf.js holds a whole document in memory while reading it; a cap keeps a pathological file
    // from taking the app down with it.
    const worker = new Worker(entry, { resourceLimits: { maxOldGenerationSizeMb: 3072 } })
    worker.on('message', (response: ExtractWorkerResponse) => {
      const job = this.jobs.get(response.id)
      if (!job) return
      if (response.pages) job.onPages(response.pages)
      if (response.done) {
        this.jobs.delete(response.id)
        job.resolve({ pageCount: response.pageCount ?? 0 })
      } else if (response.error !== undefined) {
        this.jobs.delete(response.id)
        job.reject(
          response.code
            ? new ExtractionError(response.code, response.error)
            : new Error(response.error)
        )
      }
    })
    const fail = (error: Error): void => {
      if (this.worker !== worker) return
      this.worker = null
      for (const job of this.jobs.values()) job.reject(error)
      this.jobs.clear()
    }
    worker.on('error', fail)
    worker.on('exit', (code) => {
      if (code !== 0)
        fail(
          new Error(`Document reader stopped (exit ${code}). The file may be too large to read.`)
        )
      else if (this.worker === worker) this.worker = null
    })
    worker.unref()
    this.worker = worker
    return worker
  }

  extract(
    source: DocumentSource,
    options: { signal?: AbortSignal; onPages: (pages: DocumentPage[]) => void }
  ): Promise<{ pageCount: number }> {
    const request = {
      kind: source.kind,
      ...(source.path ? { path: source.path } : {}),
      ...(source.text !== undefined ? { text: source.text } : {})
    }
    const entry = builtWorkerEntry()
    if (!entry) {
      return extractDocument(request, options.onPages, options.signal).then((pageCount) => ({
        pageCount
      }))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { onPages: options.onPages, resolve, reject })
      const worker = this.spawn(entry)
      options.signal?.addEventListener(
        'abort',
        () => worker.postMessage({ id, kind: '', cancel: true } satisfies ExtractWorkerRequest),
        {
          once: true
        }
      )
      worker.postMessage({ id, ...request } satisfies ExtractWorkerRequest)
    })
  }

  async shutdown(): Promise<void> {
    const worker = this.worker
    this.worker = null
    for (const job of this.jobs.values()) job.reject(new Error('Shutting down.'))
    this.jobs.clear()
    await worker?.terminate()
  }
}

export const documentExtractor = new DocumentExtractor()
