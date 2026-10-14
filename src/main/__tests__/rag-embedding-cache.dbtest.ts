/**
 * The desktop RAG store caches parsed document embeddings between chat turns. Against a real
 * SQLite profile, these journeys prove candidates and ranking are identical to the uncached
 * query, and that every write path (insert, re-embed, delete, enable/disable, project changes,
 * writers outside the store, a reopened connection) is visible on the very next turn.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-rag-embedding-cache-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

import * as store from '../rag/store'
import { getDB } from '../database'
import { configureRuntime } from '../runtime-env'
import { rankBySimilarity, type ChunkCandidate } from '@offgrid/rag'

configureRuntime({ dataDir: TMP_DIR })
const vs = store.desktopVectorStore

/** The store's candidate query before the cache, verbatim. */
function uncachedCandidates(projectId: string): ChunkCandidate[] {
  const db = getDB()
  const out: ChunkCandidate[] = []
  const parse = (s: string | null): number[] => {
    if (!s) return []
    try {
      const v = JSON.parse(s)
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }
  const rows = db
    .prepare(
      `SELECT c.doc_id AS docId, d.name AS name, c.content AS content, c.position AS position, c.embedding AS embedding
       FROM rag_chunks c
       JOIN rag_documents d ON d.id = c.doc_id
       WHERE d.project_id = ? AND d.enabled = 1 AND c.embedding IS NOT NULL`
    )
    .all(projectId) as {
    docId: number
    name: string
    content: string
    position: number
    embedding: string
  }[]
  for (const r of rows) {
    const embedding = parse(r.embedding)
    if (embedding.length)
      out.push({
        docId: r.docId,
        name: r.name,
        content: r.content,
        position: r.position,
        embedding
      })
  }
  if (store.projectIncludesMemory(projectId)) {
    const mems = db
      .prepare(
        `SELECT id, content, embedding FROM memories
         WHERE embedding IS NOT NULL AND embedding != '[]' LIMIT 2000`
      )
      .all() as { id: number; content: string; embedding: string }[]
    for (const m of mems) {
      const embedding = parse(m.embedding)
      if (embedding.length)
        out.push({
          docId: -m.id,
          name: 'Captured memory',
          content: m.content,
          position: 0,
          embedding
        })
    }
  }
  return out
}

async function expectSameAsUncached(projectId: string): Promise<ChunkCandidate[]> {
  const cached = await vs.getChunkCandidates(projectId)
  const expected = uncachedCandidates(projectId)
  expect(cached).toEqual(expected)
  for (const query of [
    [1, 0, 0],
    [0, 1, 0],
    [0.5, 0.5, 0.1]
  ]) {
    expect(rankBySimilarity(query, cached, 10)).toEqual(rankBySimilarity(query, expected, 10))
  }
  return cached
}

async function addDoc(
  projectId: string,
  name: string,
  vectors: (number[] | null)[]
): Promise<number> {
  const docId = await vs.addDocument({
    projectId,
    name,
    path: `/tmp/${name}`,
    size: 1,
    kind: 'text'
  })
  await vs.addChunks(
    docId,
    vectors.map((_, position) => ({ content: `${name} chunk ${position}`, position })),
    vectors.map((v) => v as number[])
  )
  return docId
}

const contents = (candidates: ChunkCandidate[]): string[] =>
  candidates.filter((c) => c.docId > 0).map((c) => c.content)

beforeAll(() => {
  store.ensureRagStoreSchema()
  getDB()
    .prepare("INSERT INTO memories (content, embedding) VALUES ('remembered', '[0.2,0.2,0.9]')")
    .run()
})

afterAll(() => {
  try {
    getDB().close()
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

describe('RAG document embedding cache', () => {
  it('returns the same candidates and ranking as the uncached query, including ties', async () => {
    store.createProject({ id: 'cache-a', name: 'A' })
    // Identical vectors make ranking depend on candidate order, so order must be preserved.
    await addDoc('cache-a', 'one.txt', [[1, 0, 0], [1, 0, 0], null, [0, 1, 0]])
    await addDoc('cache-a', 'two.txt', [
      [1, 0, 0],
      [0.3, 0.3, 0.3]
    ])
    getDB()
      .prepare(
        "INSERT INTO rag_chunks (doc_id, content, position, embedding) VALUES (?, 'bad', 9, 'not json')"
      )
      .run(
        (
          getDB().prepare("SELECT id FROM rag_documents WHERE name = 'two.txt'").get() as {
            id: number
          }
        ).id
      )

    const first = await expectSameAsUncached('cache-a')
    expect(store.ragEmbeddingCacheStats().documents).toBeGreaterThanOrEqual(2)
    const second = await expectSameAsUncached('cache-a')
    expect(second).toEqual(first)
    expect(first.some((c) => c.docId < 0)).toBe(true)
  })

  it('sees inserted chunks and documents on the next turn', async () => {
    store.createProject({ id: 'cache-insert', name: 'Insert' })
    const docId = await addDoc('cache-insert', 'grow.txt', [[1, 0, 0]])
    await expectSameAsUncached('cache-insert')

    await vs.addChunks(docId, [{ content: 'grow.txt late', position: 1 }], [[0, 0, 1]])
    await addDoc('cache-insert', 'new.txt', [[0, 1, 0]])
    const after = await expectSameAsUncached('cache-insert')
    expect(contents(after)).toEqual(['grow.txt chunk 0', 'grow.txt late', 'new.txt chunk 0'])
  })

  it('serves new vectors after a document is replaced or re-embedded in place', async () => {
    store.createProject({ id: 'cache-replace', name: 'Replace' })
    const docId = await addDoc('cache-replace', 'doc.txt', [[1, 0, 0]])
    await expectSameAsUncached('cache-replace')

    // Replace: the document is deleted and indexed again.
    await vs.deleteDocument(docId)
    const replacement = await addDoc('cache-replace', 'doc.txt', [[0, 1, 0]])
    expect((await expectSameAsUncached('cache-replace'))[0]!.embedding).toEqual([0, 1, 0])

    // Re-embed in place, as a writer outside the store could.
    getDB().prepare("UPDATE rag_chunks SET embedding = '[0,0,1]' WHERE doc_id = ?").run(replacement)
    expect((await expectSameAsUncached('cache-replace'))[0]!.embedding).toEqual([0, 0, 1])

    // Chunk ids reused after the table is emptied (sqlite_sequence reset).
    const chunkId = (
      getDB().prepare('SELECT id FROM rag_chunks WHERE doc_id = ?').get(replacement) as {
        id: number
      }
    ).id
    getDB().prepare('DELETE FROM rag_chunks WHERE id = ?').run(chunkId)
    getDB()
      .prepare(
        "INSERT INTO rag_chunks (id, doc_id, content, position, embedding) VALUES (?, ?, 'reused', 0, '[0.5,0.5,0]')"
      )
      .run(chunkId, replacement)
    expect((await expectSameAsUncached('cache-replace'))[0]!.embedding).toEqual([0.5, 0.5, 0])
  })

  it('drops deleted and disabled documents and restores re-enabled ones', async () => {
    store.createProject({ id: 'cache-toggle', name: 'Toggle' })
    const keep = await addDoc('cache-toggle', 'keep.txt', [[1, 0, 0]])
    const toggle = await addDoc('cache-toggle', 'toggle.txt', [[0, 1, 0]])
    const gone = await addDoc('cache-toggle', 'gone.txt', [[0, 0, 1]])
    await expectSameAsUncached('cache-toggle')

    await vs.deleteDocument(gone)
    await vs.setDocumentEnabled(toggle, false)
    expect(contents(await expectSameAsUncached('cache-toggle'))).toEqual(['keep.txt chunk 0'])

    await vs.setDocumentEnabled(toggle, true)
    expect(contents(await expectSameAsUncached('cache-toggle'))).toEqual([
      'keep.txt chunk 0',
      'toggle.txt chunk 0'
    ])
    expect(keep).toBeGreaterThan(0)
  })

  it('follows project changes: memory opt-out, moved documents, deleted projects', async () => {
    store.createProject({ id: 'cache-p1', name: 'P1' })
    store.createProject({ id: 'cache-p2', name: 'P2' })
    const docId = await addDoc('cache-p1', 'moving.txt', [[1, 0, 0]])
    await expectSameAsUncached('cache-p1')
    await expectSameAsUncached('cache-p2')

    store.updateProject('cache-p1', { includeMemory: false })
    expect((await expectSameAsUncached('cache-p1')).some((c) => c.docId < 0)).toBe(false)

    getDB()
      .prepare("UPDATE rag_documents SET project_id = 'cache-p2', name = 'moved.txt' WHERE id = ?")
      .run(docId)
    expect(contents(await expectSameAsUncached('cache-p1'))).toEqual([])
    const moved = await expectSameAsUncached('cache-p2')
    expect(moved.find((c) => c.docId === docId)?.name).toBe('moved.txt')

    store.deleteProject('cache-p2')
    expect(contents(await expectSameAsUncached('cache-p2'))).toEqual([])
  })

  it('stays correct across a reopened database connection', async () => {
    store.createProject({ id: 'cache-reopen', name: 'Reopen' })
    const docId = await addDoc('cache-reopen', 'r.txt', [[1, 0, 0]])
    await expectSameAsUncached('cache-reopen')

    getDB().close()
    // Written before this connection has installed its change triggers.
    getDB().prepare("UPDATE rag_chunks SET embedding = '[0,1,0]' WHERE doc_id = ?").run(docId)
    expect((await expectSameAsUncached('cache-reopen'))[0]!.embedding).toEqual([0, 1, 0])
  })

  it('keeps the cache within its memory bound', async () => {
    const stats = store.ragEmbeddingCacheStats()
    expect(stats.bytes).toBeGreaterThan(0)
    expect(stats.bytes).toBeLessThanOrEqual(64 * 1024 * 1024)
  })
})
