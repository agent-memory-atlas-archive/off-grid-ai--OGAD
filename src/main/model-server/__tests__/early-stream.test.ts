import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { endStreamWithError, openEarlyStream } from '../early-stream'

let server: http.Server | null = null
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
})

async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
}

describe('early stream for a waiting chat', () => {
  it('answers with stream headers at once, then says what it waits for', async () => {
    let finish: () => void = () => undefined
    const url = await listen((_req, res) => {
      const early = openEarlyStream(res, 'req-1')
      early.status('queued', { ahead: 2 })
      early.status('queued', { ahead: 2 })
      early.status('loading', { model: 'Flint' })
      finish = () => {
        early.stop()
        res.end('data: [DONE]\n\n')
      }
    })

    const started = Date.now()
    const response = await fetch(url)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-request-id')).toBe('req-1')

    finish()
    const frames = (await response.text())
      .split('\n\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as { choices: unknown[]; offgrid_status: unknown })
    // A repeated status is sent once; each frame is an OpenAI chunk with no choices.
    expect(frames.map((frame) => frame.offgrid_status)).toEqual([
      { phase: 'queued', ahead: 2 },
      { phase: 'loading', model: 'Flint' }
    ])
    expect(frames.every((frame) => frame.choices.length === 0)).toBe(true)
  })

  it('reports a failure after the headers went out as an error frame', async () => {
    const url = await listen((_req, res) => {
      openEarlyStream(res, 'req-2').stop()
      endStreamWithError(res, { error: { message: 'Model could not be selected.' } })
    })

    const body = await (await fetch(url)).text()
    expect(body).toContain('data: {"error":{"message":"Model could not be selected."}}')
    expect(body.trim().endsWith('data: [DONE]')).toBe(true)
  })
})
