/**
 * PaddleOCR off the main thread: decoding scan images and running detection + recognition are
 * CPU-heavy and would otherwise hold the event loop that owns the window.
 */
import { parentPort } from 'worker_threads'
import { paddleOcrPages, type PaddleModels } from './ocr-paddle-core'

if (!parentPort) throw new Error('documents-ocr-worker must be started as a worker thread')
const port = parentPort

export interface OcrWorkerRequest {
  id: number
  pdfPath: string
  pages: number[]
  models: PaddleModels | null
}
export interface OcrWorkerResponse {
  id: number
  pages?: { page: number; text: string }[]
  error?: string
}

port.on('message', (request: OcrWorkerRequest) => {
  void (async () => {
    try {
      const pages = await paddleOcrPages(request.pdfPath, request.pages, request.models)
      port.postMessage({ id: request.id, pages } satisfies OcrWorkerResponse)
    } catch (error) {
      port.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : String(error)
      } satisfies OcrWorkerResponse)
    }
  })()
})
