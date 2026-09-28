import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { getDB } from './database'
import { dataDir } from './runtime-env'
import { setAIRequestSink, invalidateAIRequests } from './ai-request-log'
import { registerPersonalStore, registerDataDeletionGuard } from './data-privacy'
import {
  AI_LOG_POLICY,
  type AIRequestRecord,
  type AIRequestSummary,
  type AILogAttachment,
  type AILogQuery,
  type AILogPage
} from '../shared/ai-request-log'

const pending = new Map<string, string>()
let queuedBytes = 0
let draining: Promise<void> | undefined
let scheduled = false
let initialized = false
let storageError: string | undefined
const root = (): string => path.join(dataDir(), 'ai-request-media')
const validId = (id: string): boolean => /^[a-f0-9-]{36}$/.test(id)

function database(): ReturnType<typeof getDB> {
  const db = getDB()
  db.exec(`CREATE TABLE IF NOT EXISTS ai_request_logs (
    id TEXT PRIMARY KEY, parent_id TEXT, started_at INTEGER NOT NULL, duration_ms INTEGER,
    modality TEXT NOT NULL, status TEXT NOT NULL, model TEXT, backend TEXT,
    search TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, bytes INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS ai_logs_started ON ai_request_logs(started_at);
  CREATE INDEX IF NOT EXISTS ai_logs_modality ON ai_request_logs(modality, started_at);
  CREATE INDEX IF NOT EXISTS ai_logs_parent ON ai_request_logs(parent_id);`)
  return db
}

async function mediaSnapshot(
  value: unknown,
  id: string,
  attachments: AILogAttachment[],
  label: string
): Promise<unknown> {
  if (typeof value === 'string') {
    const match =
      /^data:(image\/(?:png|jpeg|webp)|audio\/[\w.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(value)
    if (!match) return value
    const bytes = Buffer.from(match[2]!, 'base64')
    if (bytes.length > AI_LOG_POLICY.maxAttachmentBytes)
      return '[Media not retained: larger than 8 MB]'
    const assetId = createHash('sha256').update(bytes).digest('hex')
    await fs.mkdir(path.join(root(), id), { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(root(), id, assetId), bytes, { mode: 0o600 })
    if (!attachments.some((item) => item.id === assetId))
      attachments.push({ id: assetId, mime: match[1]!, bytes: bytes.length, label })
    return { attachment: assetId, mime: match[1], bytes: bytes.length }
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) out.push(await mediaSnapshot(item, id, attachments, label))
    return out
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value))
      out[key] = await mediaSnapshot(item, id, attachments, `${label}.${key}`)
    return out
  }
  return value
}

function preview(value: unknown): string {
  if (typeof value === 'string')
    return value.startsWith('data:') ? 'Media input' : value.slice(0, 180)
  if (Array.isArray(value)) return value.map(preview).join(' ').slice(0, 180)
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    for (const key of [
      'prompt',
      'text',
      'message',
      'messages',
      'content',
      'question',
      'input',
      'file',
      'path'
    ]) {
      if (obj[key] !== undefined) return preview(obj[key])
    }
  }
  return ''
}

async function save(record: AIRequestRecord): Promise<void> {
  // Recovered in-flight rows already contain references to retained media.
  const attachments: AILogAttachment[] = [...(record.attachments ?? [])]
  record = (await mediaSnapshot(record, record.id, attachments, 'record')) as AIRequestRecord
  record.attachments = attachments
  record.preview = preview(record.request) || record.source
  const summary: AIRequestSummary = {
    id: record.id,
    parentId: record.parentId,
    modality: record.modality,
    source: record.source,
    model: record.model,
    backend: record.backend,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs,
    preview: record.preview,
    error: record.error
  }
  const detail = JSON.stringify(record)
  const search = [
    record.source,
    record.model,
    record.backend,
    JSON.stringify(record.request),
    JSON.stringify(record.effectiveRequest),
    JSON.stringify(record.response),
    record.error
  ]
    .join(' ')
    .slice(0, AI_LOG_POLICY.maxPayloadChars)
  const bytes =
    Buffer.byteLength(detail) +
    Buffer.byteLength(search) +
    attachments.reduce((sum, asset) => sum + asset.bytes, 0)
  database()
    .prepare(
      `INSERT OR REPLACE INTO ai_request_logs
    (id,parent_id,started_at,duration_ms,modality,status,model,backend,search,summary,detail,bytes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      record.id,
      record.parentId ?? null,
      record.startedAt,
      record.durationMs ?? null,
      record.modality,
      record.status,
      record.model ?? null,
      record.backend ?? null,
      search,
      JSON.stringify(summary),
      detail,
      bytes
    )
  await prune()
}

async function prune(): Promise<void> {
  const db = database()
  const rows = db
    .prepare('SELECT id, started_at, bytes FROM ai_request_logs ORDER BY started_at DESC, id DESC')
    .all() as { id: string; started_at: number; bytes: number }[]
  let used = 0
  const expired = rows.filter((row, index) => {
    used += row.bytes
    return (
      index >= AI_LOG_POLICY.maxRecords ||
      used > AI_LOG_POLICY.maxBytes ||
      row.started_at < Date.now() - AI_LOG_POLICY.maxAgeDays * 86400000
    )
  })
  for (const row of expired) {
    db.prepare('DELETE FROM ai_request_logs WHERE id = ?').run(row.id)
    if (validId(row.id)) await fs.rm(path.join(root(), row.id), { recursive: true, force: true })
  }
}

function enqueue(record: AIRequestRecord): void {
  try {
    const json = JSON.stringify(record)
    const previous = pending.get(record.id)
    const size = queuedBytes - (previous?.length ?? 0) + json.length
    if (size > 32 * 1024 * 1024 || (!previous && pending.size >= 128)) {
      storageError = 'Some activity was not saved because the recording queue was full.'
      return
    }
    pending.set(record.id, json)
    queuedBytes = size
    if (!scheduled && draining === undefined) {
      scheduled = true
      setImmediate(() => {
        scheduled = false
        void flushAIRequestLogs()
      })
    }
  } catch {
    storageError = 'Some activity could not be saved.'
  }
}

export async function flushAIRequestLogs(): Promise<void> {
  if (draining !== undefined) return draining
  draining = (async () => {
    while (pending.size) {
      const [id, json] = pending.entries().next().value!
      pending.delete(id)
      queuedBytes -= json.length
      try {
        await save(JSON.parse(json))
      } catch {
        storageError = 'Activity storage is unavailable. AI requests are not affected.'
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  })()
  try {
    await draining
  } finally {
    draining = undefined
  }
}

export function initializeAIRequestLogs(): void {
  if (initialized) return
  initialized = true
  try {
    const db = database()
    const running = db
      .prepare("SELECT detail FROM ai_request_logs WHERE status = 'running'")
      .all() as { detail: string }[]
    for (const row of running) {
      const record = JSON.parse(row.detail) as AIRequestRecord
      record.status = 'interrupted'
      record.error = 'The app closed before this request finished.'
      enqueue(record)
    }
    void prune().catch(() => {})
  } catch {
    storageError = 'Activity storage is unavailable. AI requests are not affected.'
  }
  setAIRequestSink(enqueue)
  registerPersonalStore({ tables: ['ai_request_logs'], dirs: ['ai-request-media'] })
  registerDataDeletionGuard('ai-request-logs', {
    scopes: ['all'],
    suspend: async () => {
      setAIRequestSink(undefined)
      await flushAIRequestLogs()
    },
    resume: () => {
      setAIRequestSink(enqueue)
    }
  })
}

/** Closed sort/filter vocabulary: never interpolate caller-provided SQL. */
export function listAIRequestLogs(query: AILogQuery = {}): AILogPage {
  const clauses: string[] = []
  const values: (string | number)[] = []
  const add = (sql: string, value: string | number): void => {
    clauses.push(sql)
    values.push(value)
  }
  if (query.modality) add('modality = ?', query.modality)
  if (query.status) add('status = ?', query.status)
  if (query.since && Number.isFinite(query.since)) add('started_at >= ?', query.since)
  if (query.minDurationMs && Number.isFinite(query.minDurationMs))
    add('duration_ms >= ?', query.minDurationMs)
  if (query.search?.trim())
    add(
      "search LIKE ? ESCAPE '\\'",
      `%${query.search
        .trim()
        .slice(0, 300)
        .replace(/[\\%_]/g, '\\$&')}%`
    )
  // Mixed execution belongs in GPU results, not the CPU-only filter. Unknown
  // providers must never become CPU evidence just because GPU evidence is absent.
  if (query.hardware === 'cpu')
    clauses.push(
      "lower(trim(backend)) IN ('cpu', 'cpu (wasm)', 'wasm', 'xnnpack', 'cpu (xnnpack)')"
    )
  if (query.hardware === 'gpu')
    clauses.push(
      "(lower(backend) LIKE '%cuda%' OR lower(backend) LIKE '%metal%' OR lower(backend) LIKE '%vulkan%' OR lower(backend) LIKE '%webgpu%' OR lower(backend) LIKE '%directml%')"
    )
  if (query.hardware === 'unknown') clauses.push("(backend IS NULL OR lower(backend) = 'unknown')")
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const sort =
    query.sort === 'oldest'
      ? 'started_at ASC'
      : query.sort === 'slowest'
        ? 'duration_ms DESC'
        : 'started_at DESC'
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit || 50)))
  const offset = Math.max(0, Math.min(5000, Math.floor(query.offset || 0)))
  const db = database()
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM ai_request_logs ${where}`).get(...values) as { n: number }
  ).n
  const rows = db
    .prepare(
      `SELECT summary FROM ai_request_logs ${where} ORDER BY ${sort}, id DESC LIMIT ? OFFSET ?`
    )
    .all(...values, limit, offset) as { summary: string }[]
  return { total, rows: rows.map((row) => JSON.parse(row.summary)), storageError }
}

export function getAIRequestLog(id: string): AIRequestRecord | null {
  if (!validId(id)) return null
  const row = database().prepare('SELECT detail FROM ai_request_logs WHERE id = ?').get(id) as
    | { detail: string }
    | undefined
  return row ? JSON.parse(row.detail) : null
}

export function relatedAIRequests(id: string): AIRequestSummary[] {
  const record = getAIRequestLog(id)
  if (!record) return []
  const rootId = record.parentId ?? id
  const rows = database()
    .prepare(
      `SELECT summary FROM ai_request_logs
    WHERE id = ? OR parent_id = ? ORDER BY started_at ASC LIMIT 100`
    )
    .all(rootId, rootId) as { summary: string }[]
  return rows.map((row) => JSON.parse(row.summary)).filter((row) => row.id !== id)
}

export async function readAIRequestAttachment(id: string, assetId: string): Promise<string | null> {
  if (!validId(id) || !/^[a-f0-9]{64}$/.test(assetId)) return null
  const asset = getAIRequestLog(id)?.attachments?.find((item) => item.id === assetId)
  if (!asset) return null
  try {
    const bytes = await fs.readFile(path.join(root(), id, assetId))
    return `data:${asset.mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

export async function clearAIRequestLogs(): Promise<void> {
  // In-flight completions from before Clear must not recreate deleted history.
  invalidateAIRequests()
  setAIRequestSink(undefined)
  try {
    await flushAIRequestLogs()
    database().prepare('DELETE FROM ai_request_logs').run()
    await fs.rm(root(), { recursive: true, force: true })
    storageError = undefined
  } finally {
    setAIRequestSink(enqueue)
  }
}
