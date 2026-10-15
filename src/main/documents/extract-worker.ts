/**
 * Document extraction, off the main thread. pdf.js is pure JS: a book of thousands of pages would
 * otherwise hold the event loop that owns the window. One job at a time; pages stream back in
 * batches so the host can show progress and index while reading continues.
 */
import { parentPort } from 'worker_threads'
import { ExtractionError, extractDocument, type ExtractRequest } from './extract-core'
import type { DocumentPage } from '@offgrid/rag/documents'

if (!parentPort) throw new Error('documents-extract-worker must be started as a worker thread')
const port = parentPort

export interface ExtractWorkerRequest extends ExtractRequest {
  id: number
  cancel?: boolean
}
export interface ExtractWorkerResponse {
  id: number
  pages?: DocumentPage[]
  done?: boolean
  pageCount?: number
  error?: string
  code?: ExtractionError['code']
}

const controllers = new Map<number, AbortController>()

port.on('message', (request: ExtractWorkerRequest) => {
  if (request.cancel) {
    controllers.get(request.id)?.abort()
    return
  }
  const controller = new AbortController()
  controllers.set(request.id, controller)
  void (async () => {
    try {
      const pageCount = await extractDocument(
        request,
        (pages) => port.postMessage({ id: request.id, pages } satisfies ExtractWorkerResponse),
        controller.signal
      )
      port.postMessage({ id: request.id, done: true, pageCount } satisfies ExtractWorkerResponse)
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ExtractionError ? { code: error.code } : {})
      } satisfies ExtractWorkerResponse)
    } finally {
      controllers.delete(request.id)
    }
  })()
})
