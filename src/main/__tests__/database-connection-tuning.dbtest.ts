/**
 * The shared connection against a real SQLite profile on disk: a write still waits for another
 * connection's lock instead of failing, the chat list keeps its order and project scoping when an
 * existing profile is reopened (and gains its updated_at indexes), and planner statistics exist
 * afterwards.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-db-tuning-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import { createRagConversation, getDB, getRagConversations, optimizeDB } from '../database'
import { configureRuntime } from '../runtime-env'

configureRuntime({ dataDir: TMP_DIR })
const DB_PATH = path.join(TMP_DIR, 'memories.db')

/** Another process holds the write lock for `holdMs`; resolves as soon as it has the lock. */
function holdWriteLock(holdMs: number): Promise<{ exited: Promise<number> }> {
  const script = `
    const Database = require('better-sqlite3-multiple-ciphers')
    const db = new Database(process.argv[1])
    db.exec('BEGIN IMMEDIATE')
    process.stdout.write('locked\\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[2]))
    db.exec('COMMIT')
    db.close()
  `
  const child = spawn(process.execPath, ['-e', script, DB_PATH, String(holdMs)], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'inherit']
  })
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)))
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('locked')) resolve({ exited })
    })
    child.on('error', reject)
  })
}

function setUpdatedAt(id: string, updatedAt: string): void {
  getDB().prepare('UPDATE rag_conversations SET updated_at = ? WHERE id = ?').run(updatedAt, id)
}

beforeAll(() => {
  getDB()
})

afterAll(() => {
  getDB().close()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('shared database connection', () => {
  it('waits for another connection to release its write lock instead of failing', async () => {
    const { exited } = await holdWriteLock(400)
    expect(() => createRagConversation('after-lock', 'Written after the lock')).not.toThrow()
    expect(await exited).toBe(0)
    expect(getRagConversations().map((c) => c.id)).toContain('after-lock')
  })

  it('keeps the chat list newest-first and project-scoped across a reopened profile', () => {
    const rows: Array<[string, string | null, string]> = [
      ['c-old', null, '2026-01-01 10:00:00'],
      ['p1-a', 'p1', '2026-02-01 10:00:00'],
      ['c-new', null, '2026-03-01 10:00:00'],
      ['p1-b', 'p1', '2026-04-01 10:00:00'],
      ['p2-a', 'p2', '2026-05-01 10:00:00']
    ]
    for (const [id, projectId, updatedAt] of rows) {
      createRagConversation(id, id, projectId)
      setUpdatedAt(id, updatedAt)
    }
    getDB().prepare("DELETE FROM rag_conversations WHERE id = 'after-lock'").run()
    const before = {
      all: getRagConversations().map((c) => c.id),
      p1: getRagConversations('p1').map((c) => c.id),
      unscoped: getRagConversations(null).map((c) => c.id),
      page: getRagConversations(undefined, { limit: 2, updatedBefore: '2026-04-01 10:00:00' }).map(
        (c) => c.id
      )
    }

    getDB().close()

    expect(getRagConversations().map((c) => c.id)).toEqual(before.all)
    expect(before.all).toEqual(['p2-a', 'p1-b', 'c-new', 'p1-a', 'c-old'])
    expect(getRagConversations('p1').map((c) => c.id)).toEqual(['p1-b', 'p1-a'])
    expect(getRagConversations('p1').map((c) => c.id)).toEqual(before.p1)
    expect(getRagConversations(null).map((c) => c.id)).toEqual(['c-new', 'c-old'])
    expect(getRagConversations(null).map((c) => c.id)).toEqual(before.unscoped)
    expect(
      getRagConversations(undefined, { limit: 2, updatedBefore: '2026-04-01 10:00:00' }).map(
        (c) => c.id
      )
    ).toEqual(before.page)
  })

  it('has planner statistics after reopening a populated profile', () => {
    getDB().close()
    optimizeDB() // closed connection: nothing to do, and no error
    const stats = getDB().prepare('SELECT COUNT(*) AS n FROM sqlite_stat1').get() as { n: number }
    expect(stats.n).toBeGreaterThan(0)
    expect(() => optimizeDB()).not.toThrow()
  })
})
