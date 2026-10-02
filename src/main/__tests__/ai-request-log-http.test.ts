import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AIRequestHandle, setAIRequestSink } from '../ai-request-log'
import { observeAIResponse } from '../ai-request-log-http'
import type { AIRequestRecord } from '../../shared/ai-request-log'

afterEach(() => setAIRequestSink(undefined))
function fixture(
  sse = false,
  statusCode = 200
): {
  response: EventEmitter
  client: EventEmitter
  records: AIRequestRecord[]
} {
  const records: AIRequestRecord[] = []
  setAIRequestSink((record) => records.push(structuredClone(record)))
  const response = Object.assign(new EventEmitter(), {
    headers: { 'content-type': sse ? 'text/event-stream' : 'application/json' },
    statusCode
  })
  const client = Object.assign(new EventEmitter(), { writableFinished: false })
  observeAIResponse(
    response as IncomingMessage,
    client as ServerResponse,
    new AIRequestHandle({ modality: 'text', source: 'Gateway' })
  )
  return { response, client, records }
}
describe('passive gateway recording', () => {
  it('preserves UTF-8 split across network packets', () => {
    const { response, records } = fixture()
    const bytes = Buffer.from(JSON.stringify({ text: '你好 café' }))
    for (const byte of bytes) response.emit('data', Buffer.from([byte]))
    response.emit('end')
    expect(records.at(-1)?.response).toEqual({ text: '你好 café' })
    expect(records.at(-1)?.status).toBe('completed')
  })
  it('records SSE content and a client cancellation once', () => {
    const { response, client, records } = fixture(true)
    response.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'))
    client.emit('close')
    response.emit('error', new Error('socket closed'))
    expect(records.at(-1)?.status).toBe('cancelled')
    expect(JSON.stringify(records.at(-1)?.response)).toContain('Hello')
    expect(records.filter((row) => row.status === 'cancelled')).toHaveLength(1)
  })
  it('retains provider failures without changing the forwarded response', () => {
    const { response, records } = fixture(false, 503)
    response.emit('data', Buffer.from('{"error":"not ready"}'))
    response.emit('end')
    expect(records.at(-1)?.status).toBe('failed')
    expect(records.at(-1)?.response).toEqual({ error: 'not ready' })
  })
})
