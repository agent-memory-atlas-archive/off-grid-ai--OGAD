// DocumentIndexStore and KeywordSearchPort over the app's encrypted SQLite database (memories.db,
// SQLCipher). Documents attached to chat live here, never as plain files, so their text is
// protected like the rest of the user's data. Keyword search is SQLite FTS5 (GPT4All LocalDocs'
// approach); vectors are Float32 BLOBs beside each passage.

import { getDB } from '../database'
import {
  contentTerms,
  indexedText,
  type DocumentChunk,
  type DocumentIndexStore,
  type DocumentPage,
  type KeywordHit,
  type KeywordSearchPort,
  type StoredDocument
} from '@offgrid/rag/documents'

/**
 * FTS5's unicode61 tokenizer treats combining marks as separators, which cuts Hindi words at every
 * vowel sign ("बदलाव" → "बदल" + "ा" + "व"). The Indic blocks are declared token characters, with
 * zero-width joiners, so words stay whole; the danda (।, ॥) stays a separator. Verified against
 * the bundled SQLite 3.53 with Devanagari text.
 */
function indicTokenChars(): string {
  const chars: number[] = []
  for (let code = 0x0900; code <= 0x0d7f; code++)
    if (code !== 0x0964 && code !== 0x0965) chars.push(code)
  chars.push(0x200c, 0x200d)
  return String.fromCodePoint(...chars).replace(/'/g, "''")
}

let schemaFor: object | undefined

function db(): ReturnType<typeof getDB> {
  const database = getDB()
  if (schemaFor === database) return database
  ensureAttachedDocumentSchema(database)
  schemaFor = database
  return database
}

/** Create the attached-document tables on a connection (restore uses its own handle). */
export function ensureAttachedDocumentSchema(database: ReturnType<typeof getDB>): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS attached_documents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      embedded_count INTEGER NOT NULL DEFAULT 0,
      unreadable_pages INTEGER NOT NULL DEFAULT 0,
      embedder TEXT NOT NULL DEFAULT 'none',
      schema_version INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      map TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attached_document_pages (
      document_id TEXT NOT NULL,
      page INTEGER NOT NULL,
      label TEXT,
      text TEXT NOT NULL,
      needs_ocr INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (document_id, page)
    );
    CREATE TABLE IF NOT EXISTS attached_document_chunks (
      document_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      page INTEGER NOT NULL,
      label TEXT,
      heading TEXT,
      text TEXT NOT NULL,
      tokens INTEGER NOT NULL,
      vector BLOB,
      PRIMARY KEY (document_id, position)
    );
    CREATE TABLE IF NOT EXISTS conversation_document_exclusions (
      conversation_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      PRIMARY KEY (conversation_id, document_id)
    );
  `)
  database.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS attached_document_fts USING fts5(
      body, document_id UNINDEXED, position UNINDEXED,
      tokenize = "unicode61 remove_diacritics 0 tokenchars '${indicTokenChars()}'"
    )`
  )
}

/** Every table that holds attached-document data (for "Delete all my data"). */
export const ATTACHED_DOCUMENT_TABLES = [
  'attached_document_fts',
  'attached_document_chunks',
  'attached_document_pages',
  'conversation_document_exclusions',
  'attached_documents'
]

type DocumentRow = {
  id: string
  name: string
  kind: string
  state: StoredDocument['state']
  page_count: number
  chunk_count: number
  embedded_count: number
  unreadable_pages: number
  embedder: string
  schema_version: number
  error: string | null
  created_at: number
  last_used_at: number
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    state: row.state,
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    embeddedCount: row.embedded_count,
    unreadablePages: row.unreadable_pages,
    embedder: row.embedder,
    schemaVersion: row.schema_version,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }
}

const COLUMNS: Record<keyof Omit<StoredDocument, 'id'>, string> = {
  name: 'name',
  kind: 'kind',
  state: 'state',
  pageCount: 'page_count',
  chunkCount: 'chunk_count',
  embeddedCount: 'embedded_count',
  unreadablePages: 'unreadable_pages',
  embedder: 'embedder',
  schemaVersion: 'schema_version',
  error: 'error',
  createdAt: 'created_at',
  lastUsedAt: 'last_used_at'
}

function toBlob(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer)
}

function fromBlob(blob: Buffer): Float32Array {
  // Copy: a Buffer may share a pooled ArrayBuffer at an offset that is not 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

export const documentStore: DocumentIndexStore = {
  async getDocument(id) {
    const row = db().prepare('SELECT * FROM attached_documents WHERE id = ?').get(id) as
      DocumentRow | undefined
    return row ? toDocument(row) : null
  },

  async putDocument(document) {
    db()
      .prepare(
        `INSERT INTO attached_documents (id, name, kind, state, page_count, chunk_count, embedded_count,
           unreadable_pages, embedder, schema_version, error, created_at, last_used_at)
         VALUES (@id, @name, @kind, @state, @pageCount, @chunkCount, @embeddedCount, @unreadablePages,
           @embedder, @schemaVersion, @error, @createdAt, @lastUsedAt)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, state = excluded.state,
           page_count = excluded.page_count, chunk_count = excluded.chunk_count,
           embedded_count = excluded.embedded_count, unreadable_pages = excluded.unreadable_pages,
           embedder = excluded.embedder, schema_version = excluded.schema_version, error = excluded.error,
           last_used_at = excluded.last_used_at`
      )
      .run({ ...document, error: document.error ?? null })
  },

  async updateDocument(id, patch) {
    // Only the fields the patch names are updated (strict optional types keep undefined out).
    const entries = Object.entries(patch).filter(([key]) => key !== 'id' && key in COLUMNS)
    if (!entries.length) return
    const sets = entries
      .map(([key]) => `${COLUMNS[key as keyof typeof COLUMNS]} = @${key}`)
      .join(', ')
    db()
      .prepare(`UPDATE attached_documents SET ${sets} WHERE id = @id`)
      .run({ ...Object.fromEntries(entries), id })
  },

  async putPages(id, pages) {
    const database = db()
    const insert = database.prepare(
      `INSERT INTO attached_document_pages (document_id, page, label, text, needs_ocr) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(document_id, page) DO UPDATE SET label = excluded.label, text = excluded.text,
         needs_ocr = excluded.needs_ocr`
    )
    database.transaction((rows: DocumentPage[]) => {
      for (const page of rows)
        insert.run(id, page.page, page.label ?? null, page.text, page.needsOcr ? 1 : 0)
    })(pages)
  },

  async readPages(id) {
    return (
      db()
        .prepare(
          'SELECT page, label, text, needs_ocr FROM attached_document_pages WHERE document_id = ? ORDER BY page'
        )
        .all(id) as { page: number; label: string | null; text: string; needs_ocr: number }[]
    ).map((row) => ({
      page: row.page,
      text: row.text,
      ...(row.label ? { label: row.label } : {}),
      ...(row.needs_ocr ? { needsOcr: true } : {})
    }))
  },

  async clearChunks(id) {
    const database = db()
    database.transaction(() => {
      database.prepare('DELETE FROM attached_document_chunks WHERE document_id = ?').run(id)
      database.prepare('DELETE FROM attached_document_fts WHERE document_id = ?').run(id)
      database.prepare('UPDATE attached_documents SET map = NULL WHERE id = ?').run(id)
    })()
  },

  async appendChunks(id, chunks) {
    const database = db()
    const name =
      (
        database.prepare('SELECT name FROM attached_documents WHERE id = ?').get(id) as
          { name: string } | undefined
      )?.name ?? ''
    const insert = database.prepare(
      `INSERT OR REPLACE INTO attached_document_chunks (document_id, position, page, label, heading, text, tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    const index = database.prepare(
      'INSERT INTO attached_document_fts (body, document_id, position) VALUES (?, ?, ?)'
    )
    database.transaction((rows: DocumentChunk[]) => {
      for (const chunk of rows) {
        insert.run(
          id,
          chunk.position,
          chunk.page,
          chunk.label ?? null,
          chunk.heading ?? null,
          chunk.text,
          chunk.tokens
        )
        index.run(indexedText(name, chunk), id, chunk.position)
      }
    })(chunks)
  },

  async readChunks(id) {
    return (
      db()
        .prepare(
          'SELECT position, page, label, heading, text, tokens FROM attached_document_chunks WHERE document_id = ? ORDER BY position'
        )
        .all(id) as {
        position: number
        page: number
        label: string | null
        heading: string | null
        text: string
        tokens: number
      }[]
    ).map((row) => ({
      documentId: id,
      position: row.position,
      page: row.page,
      ...(row.label ? { label: row.label } : {}),
      ...(row.heading ? { heading: row.heading } : {}),
      text: row.text,
      tokens: row.tokens
    }))
  },

  async putVectors(id, from, vectors) {
    const database = db()
    const update = database.prepare(
      'UPDATE attached_document_chunks SET vector = ? WHERE document_id = ? AND position = ?'
    )
    database.transaction(() => {
      vectors.forEach((vector, i) => update.run(toBlob(vector), id, from + i))
    })()
  },

  async readVectors(id) {
    const rows = db()
      .prepare(
        'SELECT position, vector FROM attached_document_chunks WHERE document_id = ? AND vector IS NOT NULL'
      )
      .all(id) as { position: number; vector: Buffer }[]
    return new Map(rows.map((row) => [row.position, fromBlob(row.vector)]))
  },

  async putMap(id, positions) {
    db()
      .prepare('UPDATE attached_documents SET map = ? WHERE id = ?')
      .run(JSON.stringify(positions), id)
  },

  async readMap(id) {
    const row = db().prepare('SELECT map FROM attached_documents WHERE id = ?').get(id) as
      { map: string | null } | undefined
    if (!row?.map) return null
    try {
      const positions = JSON.parse(row.map)
      return Array.isArray(positions)
        ? positions.filter((p): p is number => typeof p === 'number')
        : null
    } catch {
      return null
    }
  },

  async deleteDocument(id) {
    const database = db()
    database.transaction(() => {
      database.prepare('DELETE FROM attached_document_fts WHERE document_id = ?').run(id)
      database.prepare('DELETE FROM attached_document_chunks WHERE document_id = ?').run(id)
      database.prepare('DELETE FROM attached_document_pages WHERE document_id = ?').run(id)
      database.prepare('DELETE FROM conversation_document_exclusions WHERE document_id = ?').run(id)
      database.prepare('DELETE FROM attached_documents WHERE id = ?').run(id)
    })()
  },

  async listDocuments() {
    return (
      db().prepare('SELECT id, last_used_at FROM attached_documents').all() as {
        id: string
        last_used_at: number
      }[]
    ).map((row) => ({ id: row.id, lastUsedAt: row.last_used_at }))
  }
}

/** An FTS5 MATCH expression from free text: quoted phrases kept, every other term OR-ed. */
export function ftsQuery(text: string): string | null {
  const quote = (term: string): string => `"${term.replace(/"/g, '""')}"`
  const phrases = [...text.matchAll(/"([^"]{3,})"/g)].map((match) => quote(match[1]!.trim()))
  const terms = contentTerms(text.replace(/"[^"]*"/g, ' ')).map(quote)
  const all = [...phrases, ...terms]
  return all.length ? all.join(' OR ') : null
}

export const documentKeywordSearch: KeywordSearchPort = {
  async search(documentIds, query, limit) {
    const match = ftsQuery(query)
    if (!match || !documentIds.length) return []
    const placeholders = documentIds.map(() => '?').join(', ')
    const rows = db()
      .prepare(
        `SELECT document_id AS documentId, position, bm25(attached_document_fts) AS rank
         FROM attached_document_fts
         WHERE attached_document_fts MATCH ? AND document_id IN (${placeholders})
         ORDER BY rank LIMIT ?`
      )
      .all(match, ...documentIds, limit) as { documentId: string; position: number; rank: number }[]
    return rows.map((row): KeywordHit => ({
      documentId: row.documentId,
      position: Number(row.position),
      score: -row.rank
    }))
  }
}

export function excludedDocuments(conversationId: string): Set<string> {
  return new Set(
    (
      db()
        .prepare(
          'SELECT document_id FROM conversation_document_exclusions WHERE conversation_id = ?'
        )
        .all(conversationId) as { document_id: string }[]
    ).map((row) => row.document_id)
  )
}

export function setDocumentExcluded(
  conversationId: string,
  documentId: string,
  excluded: boolean
): void {
  if (excluded) {
    db()
      .prepare(
        'INSERT OR IGNORE INTO conversation_document_exclusions (conversation_id, document_id) VALUES (?, ?)'
      )
      .run(conversationId, documentId)
  } else {
    db()
      .prepare(
        'DELETE FROM conversation_document_exclusions WHERE conversation_id = ? AND document_id = ?'
      )
      .run(conversationId, documentId)
  }
}

export function forgetConversationExclusions(conversationId: string): void {
  db()
    .prepare('DELETE FROM conversation_document_exclusions WHERE conversation_id = ?')
    .run(conversationId)
}
