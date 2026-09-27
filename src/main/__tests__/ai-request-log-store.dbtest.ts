import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { directory } = vi.hoisted(() => ({ directory: process.env.OFFGRID_AI_LOG_TEST_DIR ?? '' }))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ai-log-store-'))
vi.mock('electron', () => ({
  app: { getPath: () => directory || tmp },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('@lancedb/lancedb', () => ({ connect: async () => ({}) }))
import { configureRuntime } from '../runtime-env'
import { getDB } from '../database'
import { recordAIRequest, AIRequestHandle, setAIRequestSink } from '../ai-request-log'
import {
  initializeAIRequestLogs,
  flushAIRequestLogs,
  listAIRequestLogs,
  getAIRequestLog,
  readAIRequestAttachment,
  clearAIRequestLogs,
  relatedAIRequests
} from '../ai-request-log-store'
import { deleteAllData } from '../data-privacy'

beforeAll(() => {
  configureRuntime({ dataDir: tmp })
  initializeAIRequestLogs()
})
beforeEach(async () => {
  await clearAIRequestLogs()
})
afterAll(async () => {
  await flushAIRequestLogs()
  setAIRequestSink(undefined)
  getDB().close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('local AI activity storage', () => {
  it('persists real requests and supports filters, sorting and literal search', async () => {
    await recordAIRequest(
      {
        modality: 'text',
        source: 'Chat',
        model: 'Qwen',
        backend: 'CUDA',
        request: { text: 'hello 100%' }
      },
      async () => 'response'
    )
    await recordAIRequest(
      { modality: 'embedding', source: 'Index', backend: 'CPU', request: 'note' },
      async () => [1, 2]
    )
    await flushAIRequestLogs()
    expect(listAIRequestLogs().total).toBe(2)
    expect(listAIRequestLogs({ modality: 'text', hardware: 'gpu', search: '100%' }).total).toBe(1)
    expect(listAIRequestLogs({ search: '%_' }).total).toBe(0)
    expect(listAIRequestLogs({ hardware: 'cpu' }).rows[0]!.modality).toBe('embedding')
    const first = listAIRequestLogs({ sort: 'oldest', limit: 1 }).rows[0]!
    expect(getAIRequestLog(first.id)!.response).toBe('response')
    expect(listAIRequestLogs({ offset: 1, limit: 1 }).rows).toHaveLength(1)
  })
  it('keeps media out of list rows and checks asset ownership', async () => {
    await recordAIRequest({ modality: 'tts', source: 'Voice', request: 'hello' }, async () => ({
      dataUrl: 'data:audio/wav;base64,c2FtcGxl'
    }))
    await flushAIRequestLogs()
    const summary = listAIRequestLogs().rows[0]!
    expect(summary).not.toHaveProperty('response')
    const detail = getAIRequestLog(summary.id)!
    const asset = detail.attachments![0]!
    expect(await readAIRequestAttachment(summary.id, asset.id)).toBe(
      'data:audio/wav;base64,c2FtcGxl'
    )
    expect(await readAIRequestAttachment(summary.id, '../secret')).toBeNull()
    expect(
      await readAIRequestAttachment('00000000-0000-0000-0000-000000000000', asset.id)
    ).toBeNull()
    expect(JSON.stringify(detail.response)).not.toContain('c2FtcGxl')
  })
  it('keeps related failures and stops late writes after Clear', async () => {
    await recordAIRequest({ modality: 'image', source: 'Image' }, async () => {
      try {
        await recordAIRequest({ modality: 'image', source: 'GPU attempt' }, async () => {
          throw new Error('GPU stopped')
        })
      } catch {
        /* fallback */
      }
      return 'image'
    })
    await flushAIRequestLogs()
    const parent = listAIRequestLogs().rows.find((row) => !row.parentId)!
    expect(relatedAIRequests(parent.id)[0]!.status).toBe('failed')
    const late = new AIRequestHandle({ modality: 'text', source: 'in flight' })
    await clearAIRequestLogs()
    late.finish('late result')
    await flushAIRequestLogs()
    expect(listAIRequestLogs().total).toBe(0)
  })
  it('registers history and media for Delete all my data', async () => {
    await recordAIRequest({ modality: 'tts', source: 'Voice' }, async () => ({
      dataUrl: 'data:audio/wav;base64,c2FtcGxl'
    }))
    await flushAIRequestLogs()
    expect(fs.existsSync(path.join(tmp, 'ai-request-media'))).toBe(true)
    await deleteAllData()
    expect(listAIRequestLogs().total).toBe(0)
    expect(fs.readdirSync(path.join(tmp, 'ai-request-media'))).toEqual([])
  })
})
