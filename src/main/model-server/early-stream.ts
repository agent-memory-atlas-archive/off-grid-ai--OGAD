// A streaming chat that has to wait (its turn in the queue, a model loading) answers at once: the
// headers go out, a comment line every few seconds keeps the connection alive, and status frames
// say what it is waiting for. Without this the client hears nothing until the first token: an HTTP
// client gives up after its headers timeout (five minutes for Node's), and the person sees only
// "Thinking". Comment lines are ignored by every SSE reader; a status frame is an OpenAI chunk with
// no choices plus an `offgrid_status` field, which other clients skip.
import type http from 'http'

export const KEEP_ALIVE_MS = 10_000

export type WaitPhase = 'queued' | 'loading'

export interface EarlyStream {
  /** Say what the request is waiting for. */
  status(phase: WaitPhase, detail?: { ahead?: number; model?: string }): void
  /** Stop the keep-alive; the response itself continues (or ends) with the caller. */
  stop(): void
}

export function openEarlyStream(res: http.ServerResponse, requestId: string): EarlyStream {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Request-Id': requestId
  })
  res.flushHeaders()
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': waiting\n\n')
  }, KEEP_ALIVE_MS)
  timer.unref()
  let last = ''
  return {
    status(phase, detail = {}) {
      if (res.writableEnded) return
      const frame = JSON.stringify({
        object: 'chat.completion.chunk',
        choices: [],
        offgrid_status: { phase, ...detail }
      })
      if (frame === last) return
      last = frame
      res.write(`data: ${frame}\n\n`)
    },
    stop() {
      clearInterval(timer)
    }
  }
}

/** End a response whose headers already went out with an error frame, the way a stream reports
 *  a failure: an OpenAI error object in a data line, then the end of the stream. */
export function endStreamWithError(res: http.ServerResponse, body: unknown): void {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(body)}\n\n`)
  res.end('data: [DONE]\n\n')
}
