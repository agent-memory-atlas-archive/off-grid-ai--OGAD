// Connecting to a remote server reads its model list. An Off Grid gateway declares its Computer Use
// specialists (kind grounding_specialist / decision_specialist); the Mac keeps that role, so its
// chat lists never offer them, while the grounding and decision pickers still find them. The
// remote server is a real loopback HTTP server answering as the gateway does.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isRemoteChatModel, remoteCatalogRole } from '../../../shared/remote-vision-server'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-roles-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
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

const GATEWAY_MODELS = {
  object: 'list',
  data: [
    { id: 'qwen3.8-27b', name: 'Qwen3.8 27B', kind: 'chat' },
    {
      id: 'bartowski/tencent_UI-Mate-27B-GGUF',
      name: 'UI-Mate-27B',
      kind: 'grounding_specialist',
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }
    },
    {
      id: 'jaredpalmer/kev-4b',
      name: 'Kev 4B',
      kind: 'decision_specialist',
      architecture: { input_modalities: ['text'], output_modalities: ['decisions'] }
    },
    { id: 'kokoro', kind: 'speech' }
  ]
}

let gateway: http.Server
let endpoint = ''
const previousDataDir = process.env.OFFGRID_DATA_DIR

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = TMP_DIR
  gateway = http.createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(GATEWAY_MODELS))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  const address = gateway.address()
  if (!address || typeof address === 'string') throw new Error('gateway has no port')
  endpoint = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => gateway.close(() => resolve()))
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('connecting to an Off Grid gateway', () => {
  it("keeps the gateway's declared specialist roles out of chat and in their own pickers", async () => {
    const { testRemoteVisionServer } = await import('../remote-vision-server')
    const result = await testRemoteVisionServer({ provider: 'custom', endpoint, model: '' })

    expect(result.ok).toBe(true)
    const models = result.models ?? []
    expect(models.filter(isRemoteChatModel).map((model) => model.id)).toEqual(['qwen3.8-27b'])
    const byId = new Map(models.map((model) => [model.id, model]))
    expect(byId.get('bartowski/tencent_UI-Mate-27B-GGUF')).toMatchObject({
      kind: 'text',
      role: 'grounding'
    })
    expect(remoteCatalogRole(byId.get('jaredpalmer/kev-4b')!)).toBe('decision')
    expect(byId.get('kokoro')?.kind).toBe('voice')
  })
})
