/**
 * Team gateway mode across runtimes, over real HTTP. The fakes sit only at the native process
 * boundary: whisper-cli, ffmpeg and sd-cli are small scripts that log when each run starts and
 * ends, and llama-server is a loopback server on its production port. Everything between (the
 * gateway, transcription and image orchestration, the modality queue, the limiters) is real.
 *
 * Single mode keeps today's behaviour: transcriptions are not queued at all, images one at a time.
 * Team mode runs transcriptions side by side up to the RAM rule, queues the rest fairly and refuses
 * the overflow with 429, keeps images one at a time in a fair line, and lets a chat stream and a
 * transcription run at once.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { LLAMA_SERVER_PORT } from '../../shared/ports'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-team-runtimes-'))
const dataDir = path.join(root, 'data')
const binDir = path.join(root, 'bin')
const runLog = path.join(root, 'runs.log')

vi.mock('electron', () => ({
  app: {
    getPath: () => dataDir,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const IMAGE_MODEL = 'team-image-fixture.safetensors'

/** A native-process fake: logs start and end with the run's kind, takes `ms`, then does `finish`. */
function installProcess(relative: string, kind: string, ms: number, finish: string): void {
  const file = path.join(binDir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const id = Math.random().toString(36).slice(2)
fs.appendFileSync(${JSON.stringify(runLog)}, '${kind} start ' + id + ' ' + Date.now() + '\\n')
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(runLog)}, '${kind} end ' + id + ' ' + Date.now() + '\\n')
  ${finish}
}, ${ms})
`
  )
  fs.chmodSync(file, 0o755)
}

/** The most runs of `kind` that were in progress at the same moment. */
function peak(kind: string): number {
  if (!fs.existsSync(runLog)) return 0
  let running = 0
  let most = 0
  for (const line of fs.readFileSync(runLog, 'utf8').trim().split('\n')) {
    const [k, event] = line.split(' ')
    if (k !== kind) continue
    running += event === 'start' ? 1 : -1
    most = Math.max(most, running)
  }
  return most
}

function runs(kind: string): number {
  if (!fs.existsSync(runLog)) return 0
  return fs
    .readFileSync(runLog, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${kind} end`)).length
}

let gatewayPort: number
let upstream: http.Server
let holdChat: (() => void) | null = null
let llm: typeof import('../llm').llm
let teamConcurrency: typeof import('../model-server/team-runtimes').teamConcurrency
let stopModelServer: () => void

function transcribe(): Promise<{ status: number; body: string; retryAfter: string | null }> {
  const form = new FormData()
  form.append('file', new Blob([Buffer.alloc(256, 1)], { type: 'audio/wav' }), 'note.wav')
  return fetch(`http://127.0.0.1:${gatewayPort}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form
  }).then(async (response) => ({
    status: response.status,
    body: await response.text(),
    retryAfter: response.headers.get('retry-after')
  }))
}

function image(): Promise<{ status: number; body: string }> {
  return fetch(`http://127.0.0.1:${gatewayPort}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'A green cabin', model: IMAGE_MODEL })
  }).then(async (response) => ({ status: response.status, body: await response.text() }))
}

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = dataDir
  process.env.OFFGRID_BIN_DIR = binDir
  const models = path.join(dataDir, 'models')
  fs.mkdirSync(models, { recursive: true })
  fs.writeFileSync(path.join(models, 'ggml-base.bin'), 'synthetic whisper model')
  fs.writeFileSync(path.join(models, IMAGE_MODEL), 'fixture checkpoint')
  fs.copyFileSync(path.resolve('e2e/fixtures/hey-how-are-you-doing.wav'), path.join(root, 'e2e-voice.wav'))
  fs.mkdirSync(binDir, { recursive: true })
  fs.copyFileSync(path.resolve('e2e/fixtures/copy-ffmpeg.sh'), path.join(binDir, 'ffmpeg'))
  fs.chmodSync(path.join(binDir, 'ffmpeg'), 0o755)
  installProcess('whisper/whisper-cli', 'stt', 400, `process.stdout.write('Book a table by the river\\n')`)
  installProcess(
    'sd/sd-cli',
    'image',
    300,
    `fs.writeFileSync(value('-o'), Buffer.from('${PNG_BASE64}', 'base64'))`
  )

  // llama-server: one chat stream that stays open until the test lets it end.
  upstream = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"thinking"}}]}\n\n')
      holdChat = () => res.end('data: {"choices":[{"delta":{"content":" done"}}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(LLAMA_SERVER_PORT, '127.0.0.1', () => resolve())
  })

  ;({ llm } = await import('../llm'))
  ;({ teamConcurrency } = await import('../model-server/team-runtimes'))
  const gateway = await import('../model-server')
  stopModelServer = gateway.stopModelServer
  gatewayPort = await unusedPort()
  await gateway.startModelServer(gatewayPort)
})

afterEach(() => {
  fs.rmSync(runLog, { force: true })
})

afterAll(async () => {
  holdChat?.()
  stopModelServer()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
  delete process.env.OFFGRID_DATA_DIR
  delete process.env.OFFGRID_BIN_DIR
  fs.rmSync(root, { recursive: true, force: true })
})

describe('single mode keeps every runtime as it is today', () => {
  it('runs transcriptions without a queue, as before', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const results = await Promise.all(Array.from({ length: 4 }, () => transcribe()))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200])
    expect(JSON.parse(results[0]!.body)).toMatchObject({ text: 'Book a table by the river' })
    expect(peak('stt')).toBe(4)
  })

  it('generates images one at a time', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    const results = await Promise.all([image(), image()])
    expect(results.map((r) => r.status)).toEqual([200, 200])
    expect(peak('image')).toBe(1)
  })
})

describe('team mode', () => {
  it('runs as many transcriptions at once as the RAM rule allows and queues the next', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const workers = teamConcurrency().transcription
    const results = await Promise.all(Array.from({ length: workers + 1 }, () => transcribe()))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(runs('stt')).toBe(workers + 1)
    expect(peak('stt')).toBe(workers)
  })

  it('refuses transcriptions past the bounded line with 429 and Retry-After', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const workers = teamConcurrency().transcription
    const results = await Promise.all(
      Array.from({ length: workers + workers * 4 + 2 }, () => transcribe())
    )
    const refused = results.filter((r) => r.status === 429)
    expect(refused.length).toBeGreaterThan(0)
    expect(refused[0]!.retryAfter).toBe('2')
    expect(JSON.parse(refused[0]!.body)).toMatchObject({ error: { type: 'rate_limit_error' } })
    expect(results.filter((r) => r.status === 200)).toHaveLength(workers + workers * 4)
  })

  it('keeps image generation one at a time in a fair line', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const results = await Promise.all([image(), image(), image()])
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(peak('image')).toBe(1)
  })

  it('transcribes while a chat stream is still open', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    holdChat = null
    const chat = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
    }).then((response) => response.text())
    const deadline = Date.now() + 3_000
    while (!holdChat && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
    expect(holdChat).not.toBeNull()
    const transcription = await transcribe()
    expect(transcription.status).toBe(200)
    // The stream is still open: the transcription did not wait behind it.
    holdChat!()
    expect(await chat).toContain('done')
  })
})
