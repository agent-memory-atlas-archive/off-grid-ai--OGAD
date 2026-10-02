import type { IncomingMessage, ServerResponse } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import type { AIRequestHandle } from './ai-request-log'
import { createCompletionStreamAccumulator } from './llm/stream'
import { AI_LOG_POLICY } from '../shared/ai-request-log'

/** Passive observer: forwarding, backpressure and cancellation remain owned by the gateway. */
export function observeAIResponse(
  response: IncomingMessage,
  client: ServerResponse,
  log?: AIRequestHandle
): void {
  if (!log) return
  const sse = String(response.headers['content-type']).includes('text/event-stream')
  const accumulator = createCompletionStreamAccumulator((text, kind) => log.delta(text, kind))
  let body = ''
  let retained = 0
  let truncated = false
  let ended = false
  const decoder = new StringDecoder('utf8')
  const collect = (text: string): void => {
    const remaining = AI_LOG_POLICY.maxPayloadChars - retained
    if (text.length > remaining) truncated = true
    const part = text.slice(0, Math.max(0, remaining))
    retained += part.length
    try {
      if (sse) accumulator.push(part)
      else body += part
    } catch {
      /* Logging is non-critical. */
    }
  }
  const finish = (error?: Error, cancelled = false): void => {
    if (ended) return
    ended = true
    collect(decoder.end())
    client.off('close', onClose)
    let result: unknown = body
    try {
      result = sse ? accumulator.finish() : JSON.parse(body)
    } catch {
      /* Plain text error body. */
    }
    if (truncated) result = { partial: result, note: 'Truncated: log size limit' }
    log.finish(
      result,
      error ??
        ((response.statusCode ?? 200) >= 400
          ? new Error(`HTTP ${response.statusCode}`)
          : undefined),
      cancelled
    )
  }
  const onClose = (): void => finish(undefined, !client.writableFinished)
  client.on('close', onClose)
  response.on('data', (chunk: Buffer) => {
    if (ended) return
    collect(typeof chunk === 'string' ? chunk : decoder.write(chunk))
  })
  response.once('end', () => finish())
  response.once('error', (error) => finish(error))
  response.once('aborted', () => finish(new Error('Upstream response interrupted')))
}
