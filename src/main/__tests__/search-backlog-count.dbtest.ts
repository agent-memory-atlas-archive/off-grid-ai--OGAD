/**
 * The search backfill no longer recounts all seven pending sources after every batch. These
 * journeys prove the progress it reports still equals the full seven-source count, that the
 * backlog reaches an exact zero, and that items added during or after a run are still found.
 * Electron, the embedding model and the vector store are the only replaced boundaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-backlog-count-'))
const originalDataDir = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = PROFILE_DIR

vi.mock('electron', () => ({
  app: { getPath: () => PROFILE_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('../embeddings', () => ({
  embeddings: { generateEmbedding: async () => [0.1, 0.2, 0.3] }
}))
vi.mock('../vectors', () => ({
  addChunks: async () => {},
  searchVectors: async () => [],
  vectorCount: async () => 0
}))

import { getDB } from '../database'
import { runBackfill, searchStatus } from '../search'
import { PENDING_COUNT_SQL } from '../search-backfill-queries'

const TEXT = 'a captured line long enough to be embedded'

function exactPending(): number {
  return (getDB().prepare(PENDING_COUNT_SQL).get() as { c: number }).c
}

/** Add `n` pending items to each of the seven sources. */
function seed(n: number, tag: string): void {
  const db = getDB()
  db.transaction(() => {
    for (let index = 0; index < n; index++) {
      const text = `${TEXT} ${tag} ${index}`
      db.prepare("INSERT INTO frames (surface, text) VALUES ('Slack', ?)").run(text)
      db.prepare("INSERT INTO observations (summary, surface) VALUES (?, 'Slack')").run(text)
      db.prepare('INSERT INTO chat_summaries (session_id, summary) VALUES (?, ?)').run(
        `s-${tag}-${index}`,
        text
      )
      db.prepare('INSERT INTO meetings (title, summary) VALUES (?, ?)').run('Standup', text)
      db.prepare('INSERT INTO memories (content) VALUES (?)').run(text)
      const entity = db
        .prepare("INSERT INTO entities (name, type, summary, hidden) VALUES (?, 'Person', ?, 0)")
        .run(`Person ${tag} ${index}`, text)
      db.prepare('INSERT INTO entity_facts (entity_id, fact) VALUES (?, ?)').run(
        entity.lastInsertRowid,
        text
      )
    }
  })()
}

beforeAll(() => {
  // Pro's capture tables, as its schema creates them; a core DB test cannot import Pro.
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS frames (id INTEGER PRIMARY KEY AUTOINCREMENT, ts DATETIME DEFAULT CURRENT_TIMESTAMP, surface TEXT, url TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT, surface TEXT, url TEXT, ts DATETIME);
    CREATE TABLE IF NOT EXISTS meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, summary TEXT, transcript TEXT, started_at INTEGER);
  `)
  try {
    getDB().exec('ALTER TABLE entities ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0')
  } catch {
    /* already present */
  }
})

beforeEach(() => {
  getDB().exec(`
    DELETE FROM vec_indexed; DELETE FROM frames; DELETE FROM observations; DELETE FROM chat_summaries;
    DELETE FROM meetings; DELETE FROM memories; DELETE FROM entity_facts; DELETE FROM entities;
  `)
})

afterAll(() => {
  getDB().close()
  if (originalDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = originalDataDir
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
})

describe('search backfill backlog count', () => {
  beforeAll(() => {
    getDB().exec('CREATE TABLE IF NOT EXISTS vec_indexed (key TEXT PRIMARY KEY)')
  })

  it('reports the full seven-source count after every batch and finishes at zero', async () => {
    seed(20, 'a')
    expect((await searchStatus()).pending).toBe(140)

    const reported: { remaining: number; exact: number }[] = []
    await runBackfill((progress) =>
      reported.push({ remaining: progress.remaining, exact: exactPending() })
    )

    expect(reported.length).toBeGreaterThan(2)
    for (const step of reported) expect(step.remaining).toBe(step.exact)
    expect(reported.at(-1)!.remaining).toBe(0)
    expect((await searchStatus()).pending).toBe(0)
    const sources = getDB()
      .prepare(
        "SELECT substr(key, 1, instr(key, ':') - 1) AS source, COUNT(*) AS n FROM vec_indexed GROUP BY source ORDER BY source"
      )
      .all()
    expect(sources).toEqual([
      { source: 'ent', n: 20 },
      { source: 'fact', n: 20 },
      { source: 'frame', n: 20 },
      { source: 'mem', n: 20 },
      { source: 'mtg', n: 20 },
      { source: 'obs', n: 20 },
      { source: 'sum', n: 20 }
    ])
  })

  it('does not report done while items added during the run are still pending', async () => {
    seed(10, 'b')
    let added = false
    const reported: number[] = []
    await runBackfill((progress) => {
      reported.push(progress.remaining)
      if (!added) {
        added = true
        seed(3, 'late')
      }
    })

    expect(reported.at(-1)).toBe(0)
    expect(exactPending()).toBe(0)
    expect(
      (getDB().prepare('SELECT COUNT(*) AS n FROM vec_indexed').get() as { n: number }).n
    ).toBe(13 * 7)
  })

  it('notices items added after a completed run', async () => {
    seed(2, 'c')
    await runBackfill()
    expect((await searchStatus()).pending).toBe(0)

    seed(1, 'd')
    expect((await searchStatus()).pending).toBe(7)
    await runBackfill()
    expect((await searchStatus()).pending).toBe(0)
  })
})
