/**
 * AI activity retention against a real SQLite profile: the three limits (record count, age,
 * total bytes), removal of each deleted row's media directory, rows of every status treated
 * alike, and the throttle that keeps retention off the per-request path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ai-log-retention-'))
vi.mock('electron', () => ({
  app: { getPath: () => tmp },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('@lancedb/lancedb', () => ({ connect: async () => ({}) }))

import { configureRuntime } from '../runtime-env'
import { getDB } from '../database'
import { recordAIRequest, setAIRequestSink } from '../ai-request-log'
import {
  initializeAIRequestLogs,
  flushAIRequestLogs,
  clearAIRequestLogs,
  pruneAIRequestLogs
} from '../ai-request-log-store'
import { AI_LOG_POLICY } from '../../shared/ai-request-log'

const DAY = 86400000
const media = (id: string): string => path.join(tmp, 'ai-request-media', id)

type Row = { id: string; startedAt: number; bytes: number; status?: string }

function insert(rows: Row[]): void {
  const statement = getDB().prepare(
    `INSERT INTO ai_request_logs
      (id,parent_id,started_at,duration_ms,modality,status,model,backend,search,summary,detail,bytes)
     VALUES (?,NULL,?,NULL,'text',?,NULL,NULL,'','{}','{}',?)`
  )
  getDB().transaction(() => {
    for (const row of rows)
      statement.run(row.id, row.startedAt, row.status ?? 'completed', row.bytes)
  })()
}

function withMedia(rows: Row[]): Row[] {
  for (const row of rows) {
    fs.mkdirSync(media(row.id), { recursive: true })
    fs.writeFileSync(path.join(media(row.id), 'a'.repeat(64)), 'x')
  }
  return rows
}

function ids(): string[] {
  return (getDB().prepare('SELECT id FROM ai_request_logs').all() as { id: string }[])
    .map((row) => row.id)
    .sort()
}

/** The per-row algorithm this store used before set-based retention. */
function referenceSurvivors(rows: Row[], now: number): string[] {
  const ordered = [...rows].sort((a, b) =>
    a.startedAt !== b.startedAt ? b.startedAt - a.startedAt : a.id < b.id ? 1 : -1
  )
  let used = 0
  return ordered
    .filter((row, index) => {
      used += row.bytes
      return !(
        index >= AI_LOG_POLICY.maxRecords ||
        used > AI_LOG_POLICY.maxBytes ||
        row.startedAt < now - AI_LOG_POLICY.maxAgeDays * DAY
      )
    })
    .map((row) => row.id)
    .sort()
}

beforeAll(async () => {
  configureRuntime({ dataDir: tmp })
  initializeAIRequestLogs()
  await flushAIRequestLogs()
})
beforeEach(async () => {
  vi.restoreAllMocks()
  await clearAIRequestLogs()
})
afterAll(async () => {
  vi.restoreAllMocks()
  await flushAIRequestLogs()
  setAIRequestSink(undefined)
  getDB().close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AI activity retention', () => {
  it('ages out rows past maxAgeDays, running or not, and removes their media', async () => {
    const now = Date.now()
    const old = withMedia([
      { id: randomUUID(), startedAt: now - 8 * DAY, bytes: 10 },
      { id: randomUUID(), startedAt: now - 9 * DAY, bytes: 10, status: 'running' }
    ])
    const recent = withMedia([
      { id: randomUUID(), startedAt: now - 6 * DAY, bytes: 10 },
      { id: randomUUID(), startedAt: now - 1000, bytes: 10, status: 'running' }
    ])
    insert([...old, ...recent])

    expect(await pruneAIRequestLogs(now)).toBe(2)
    expect(ids()).toEqual(recent.map((row) => row.id).sort())
    for (const row of old) expect(fs.existsSync(media(row.id))).toBe(false)
    for (const row of recent) expect(fs.existsSync(media(row.id))).toBe(true)
  })

  it('keeps only the newest maxRecords rows', async () => {
    const now = Date.now()
    const rows: Row[] = Array.from({ length: AI_LOG_POLICY.maxRecords + 3 }, (_, index) => ({
      id: randomUUID(),
      startedAt: now - index * 10,
      bytes: 1
    }))
    const oldest = withMedia(rows.slice(-3))
    insert(rows)

    expect(await pruneAIRequestLogs(now)).toBe(3)
    expect(ids()).toEqual(
      rows
        .slice(0, AI_LOG_POLICY.maxRecords)
        .map((row) => row.id)
        .sort()
    )
    for (const row of oldest) expect(fs.existsSync(media(row.id))).toBe(false)
  })

  it('drops rows once the newest-first running total passes maxBytes', async () => {
    const now = Date.now()
    const big = 100 * 1024 * 1024
    const rows = withMedia([
      { id: randomUUID(), startedAt: now - 1, bytes: big },
      { id: randomUUID(), startedAt: now - 2, bytes: big },
      { id: randomUUID(), startedAt: now - 3, bytes: big },
      // Still dropped: the running total already passed the limit, as before.
      { id: randomUUID(), startedAt: now - 4, bytes: 1 }
    ])
    insert(rows)

    expect(await pruneAIRequestLogs(now)).toBe(2)
    expect(ids()).toEqual([rows[0]!.id, rows[1]!.id].sort())
    expect(fs.existsSync(media(rows[2]!.id))).toBe(false)
    expect(fs.existsSync(media(rows[3]!.id))).toBe(false)
  })

  it('matches the previous per-row algorithm on mixed data, including timestamp ties', async () => {
    const now = Date.now()
    let seed = 7
    const random = (): number => (seed = (seed * 48271) % 2147483647) / 2147483647
    const rows: Row[] = Array.from({ length: AI_LOG_POLICY.maxRecords + 400 }, () => ({
      id: randomUUID(),
      startedAt: now - Math.floor(random() * 9) * DAY - Math.floor(random() * 4),
      bytes: Math.floor(random() * 120_000),
      status: random() < 0.1 ? 'running' : 'completed'
    }))
    insert(rows)
    const expected = referenceSurvivors(rows, now)

    await pruneAIRequestLogs(now)
    expect(ids()).toEqual(expected)
  })

  it('does not run retention after every save, but runs it once the interval has passed', async () => {
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    await pruneAIRequestLogs(start)
    const stale = withMedia([{ id: randomUUID(), startedAt: start - 8 * DAY, bytes: 1 }])[0]!
    insert([stale])

    await recordAIRequest({ modality: 'text', source: 'Chat' }, async () => 'done')
    await flushAIRequestLogs()
    expect(ids()).toContain(stale.id)

    clock.mockReturnValue(start + 61_000)
    await recordAIRequest({ modality: 'text', source: 'Chat' }, async () => 'done')
    await flushAIRequestLogs()
    expect(ids()).not.toContain(stale.id)
    expect(fs.existsSync(media(stale.id))).toBe(false)
  })

  it('runs retention early when many rows were saved since the last pass', async () => {
    const start = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(start)
    await pruneAIRequestLogs(start)
    const stale = { id: randomUUID(), startedAt: start - 8 * DAY, bytes: 1 }
    insert([stale])

    // At least one save per request (its running row can be coalesced with the completion).
    for (let index = 0; index < 100; index++) {
      await recordAIRequest({ modality: 'text', source: 'Chat' }, async () => 'done')
    }
    await flushAIRequestLogs()
    expect(ids()).not.toContain(stale.id)
  })
})
