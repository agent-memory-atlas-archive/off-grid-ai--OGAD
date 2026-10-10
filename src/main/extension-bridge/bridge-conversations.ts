// Mapping between OGAD's chat tables (rag_conversations / rag_messages) and the conversation
// shape the extension syncs. Pure, unit-tested.
//
// Writes from a browser are APPEND-ONLY: a push adds the turns the desktop does not have yet
// and never edits or removes what is already stored, so a stale browser can't erase a chat.

export interface BridgeTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

export interface BridgeConversation {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly origin: 'browser' | 'desktop' | 'mobile'
  readonly turns: readonly BridgeTurn[]
}

interface ConversationRow {
  readonly id: string
  readonly title?: string | null
  readonly origin_device_id?: string | null
  readonly created_at?: string | null
  readonly updated_at?: string | null
}

interface MessageRow {
  readonly role: string
  readonly content: string
}

/** Browser-origin conversations are tagged so their origin survives the round trip. */
export const BROWSER_ORIGIN_PREFIX = 'browser:'

export const MAX_LISTED = 100
export const MAX_TURNS = 40
export const MAX_TURN_CHARS = 20_000

/** SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) to epoch ms; 0 when unreadable. */
export function sqlTime(value: string | null | undefined): number {
  if (!value) return 0
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

export function originOf(row: ConversationRow): BridgeConversation['origin'] {
  const device = row.origin_device_id
  if (!device) return 'desktop'
  return device.startsWith(BROWSER_ORIGIN_PREFIX) ? 'browser' : 'mobile'
}

export function toBridgeConversation(
  row: ConversationRow,
  messages: readonly MessageRow[]
): BridgeConversation {
  const turns = messages
    .filter((m): m is BridgeTurn => m.role === 'user' || m.role === 'assistant')
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TURN_CHARS) }))
  return {
    id: row.id,
    title: row.title || turns.find((t) => t.role === 'user')?.content.slice(0, 48) || 'Chat',
    createdAt: sqlTime(row.created_at),
    updatedAt: sqlTime(row.updated_at),
    origin: originOf(row),
    turns
  }
}

const ID = /^[A-Za-z0-9_-]{8,64}$/

/** Validate a conversation a browser pushed. Field by field; null on anything malformed. */
export function parseBridgeConversation(raw: unknown): BridgeConversation | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  if (typeof c.id !== 'string' || !ID.test(c.id) || typeof c.title !== 'string') return null
  if (!Array.isArray(c.turns) || c.turns.length > MAX_TURNS * 4) return null
  const turns: BridgeTurn[] = []
  for (const t of c.turns) {
    const turn = t as Record<string, unknown> | null
    if ((turn?.role !== 'user' && turn?.role !== 'assistant') || typeof turn.content !== 'string') {
      return null
    }
    turns.push({ role: turn.role, content: turn.content.slice(0, MAX_TURN_CHARS) })
  }
  return {
    id: c.id,
    title: c.title.slice(0, 200),
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0,
    updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
    origin: 'browser',
    turns
  }
}

/**
 * The turns to append so the desktop catches up with the browser. The browser keeps only its
 * latest turns, so what it sends is a window: the end of the desktop's stored turns must match the
 * start of that window, and whatever follows the overlap is new. The longest overlap wins, so a
 * repeated short turn never makes old turns look new. With no overlap (a diverged or stale
 * history) nothing is appended, so the desktop's copy is never contradicted.
 */
export function turnsToAppend(
  stored: readonly MessageRow[],
  incoming: readonly BridgeTurn[]
): BridgeTurn[] {
  const have = stored.filter((m) => m.role === 'user' || m.role === 'assistant')
  if (!have.length) return [...incoming]
  const same = (m: MessageRow, turn: BridgeTurn | undefined): boolean =>
    turn !== undefined &&
    m.role === turn.role &&
    m.content.slice(0, MAX_TURN_CHARS) === turn.content
  for (let overlap = Math.min(have.length, incoming.length); overlap > 0; overlap--) {
    const tail = have.slice(have.length - overlap)
    if (tail.every((m, i) => same(m, incoming[i]))) return incoming.slice(overlap)
  }
  return []
}

/**
 * Whether a browser's history contradicts the desktop's: it neither continues the stored turns
 * (turnsToAppend) nor is an older window of them. An edited or regenerated turn reads this way.
 * The desktop has no record of what the browser saw last, so it cannot tell an edit from turns
 * added here since, and refuses rather than overwrite either one.
 */
export function historyConflicts(
  stored: readonly MessageRow[],
  incoming: readonly BridgeTurn[]
): boolean {
  const have = stored.filter((m) => m.role === 'user' || m.role === 'assistant')
  if (!have.length || !incoming.length || turnsToAppend(stored, incoming).length) return false
  const same = (m: MessageRow, turn: BridgeTurn): boolean =>
    m.role === turn.role && m.content.slice(0, MAX_TURN_CHARS) === turn.content
  for (let start = 0; start + incoming.length <= have.length; start++) {
    if (incoming.every((turn, i) => same(have[start + i]!, turn))) return false
  }
  return true
}

/** The title a browser renamed its chat to, when that rename is newer than the desktop's copy. */
export function newerBrowserTitle(
  row: ConversationRow,
  conversation: BridgeConversation
): string | null {
  const title = conversation.title.trim()
  if (!title || title === (row.title ?? '')) return null
  return conversation.updatedAt > sqlTime(row.updated_at) ? title : null
}

/** What a refused browser edit says: the extension keeps an edit whose refusal names a conflict. */
export const HISTORY_CONFLICT =
  'conflict: this chat changed differently on the desktop, so the edit was kept in the browser'
