// Full-text index over every captured frame's on-screen text. Search used to LIKE-scan all of
// frames.text (hundreds of MB) on the main thread for every query, which took seconds. The index
// is contentless (the text is not stored twice) with contentless_delete, so a frame that changes
// or goes away is simply dropped from it. New and edited frames are indexed by triggers; frames
// captured before the index existed are indexed in the background, newest first, in small batches.

import { getDB, getSetting, saveSetting } from './database'

/** The lowest frame id already indexed by the backfill; 0 once every older frame is indexed. */
export const FRAME_TEXT_INDEX_CURSOR = 'search:frame-fts-cursor'

/** Frames per backfill batch: small enough that a batch never holds the main thread for long. */
const BACKFILL_BATCH = 200
const BACKFILL_PAUSE_MS = 150

interface IndexDatabase {
  exec(sql: string): void
  prepare(sql: string): { get(...args: unknown[]): unknown }
}

/** Create the index and its triggers on a database that has the frames table. Idempotent. */
export function ensureFrameTextIndex(db: IndexDatabase): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'frame_fts'")
    .get()
  if (!exists) {
    db.exec(
      `CREATE VIRTUAL TABLE frame_fts USING fts5(
         text, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2'
       )`
    )
    // Everything below this id predates the index; the backfill works down from here.
    const top = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM frames').get() as {
      id: number
    }
    saveSetting(FRAME_TEXT_INDEX_CURSOR, top.id)
  }
  // Synced mail and chat frames stay out, as search already left them out.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS frames_fts_ai AFTER INSERT ON frames
    WHEN new.text IS NOT NULL AND COALESCE(new.source, '') != 'connector' BEGIN
      INSERT INTO frame_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS frames_fts_ad AFTER DELETE ON frames BEGIN
      DELETE FROM frame_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER IF NOT EXISTS frames_fts_au AFTER UPDATE OF text, source ON frames BEGIN
      DELETE FROM frame_fts WHERE rowid = old.id;
      INSERT INTO frame_fts(rowid, text)
        SELECT new.id, new.text
         WHERE new.text IS NOT NULL AND COALESCE(new.source, '') != 'connector';
    END;
  `)
}

/** True while frames captured before the index still wait to be indexed. */
export function frameTextIndexBackfilling(): boolean {
  return getSetting<number>(FRAME_TEXT_INDEX_CURSOR, 1) > 1
}

/** Index one batch of older frames, newest first. Returns whether more remain. */
export function indexFrameTextBatch(batch = BACKFILL_BATCH): boolean {
  const cursor = getSetting<number>(FRAME_TEXT_INDEX_CURSOR, 0)
  if (cursor <= 1) return false
  const db = getDB()
  const rows = db
    .prepare('SELECT id, text, source FROM frames WHERE id < ? ORDER BY id DESC LIMIT ?')
    .all(cursor, batch) as { id: number; text: string | null; source: string | null }[]
  if (!rows.length) {
    saveSetting(FRAME_TEXT_INDEX_CURSOR, 0)
    return false
  }
  const drop = db.prepare('DELETE FROM frame_fts WHERE rowid = ?')
  const add = db.prepare('INSERT INTO frame_fts(rowid, text) VALUES (?, ?)')
  db.transaction(() => {
    for (const row of rows) {
      // An edit since the index existed may already have indexed this frame.
      drop.run(row.id)
      if (row.text && row.source !== 'connector') add.run(row.id, row.text)
    }
  })()
  saveSetting(FRAME_TEXT_INDEX_CURSOR, rows[rows.length - 1]!.id)
  return true
}

let running = false

/** Index older frames in the background until none are left, or until `signal` aborts (app
 *  shutdown). Safe to call more than once. */
export function startFrameTextIndexBackfill(signal?: AbortSignal): void {
  if (running || !frameTextIndexBackfilling()) return
  running = true
  const step = (): void => {
    if (signal?.aborted) {
      running = false
      return
    }
    let more = false
    try {
      more = indexFrameTextBatch()
    } catch (error) {
      console.error('[search] frame text index backfill failed:', error)
    }
    if (more) setTimeout(step, BACKFILL_PAUSE_MS)
    else running = false
  }
  setTimeout(step, BACKFILL_PAUSE_MS)
}
