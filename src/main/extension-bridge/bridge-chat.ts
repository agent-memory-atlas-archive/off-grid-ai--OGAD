// Shared bridge contract. Desktop owns execution; browsers read bounded event pages.
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}
export interface ChatStart {
  runId: string
  conversationId: string
  prompt: string
  mode: 'chat' | 'agent' | 'image'
  branch?: boolean | undefined
  history?: ChatTurn[] | undefined
  pageText?: string | undefined
  imageDataUrl?: string | undefined
  tabId?: number | undefined
}
export interface ChatRead {
  runId: string
  conversationId: string
  cursor: number
  done: boolean
  events: unknown[]
  prompt?: string | undefined
  history?: ChatTurn[] | undefined
  tabId?: number | undefined
}
export type ChatRequest =
  | { action: 'start'; input: ChatStart }
  | { action: 'read'; runId: string; cursor: number }
  | { action: 'stop'; runId: string }
  | { action: 'disconnect' }
  | { action: 'conversations' }

export const validChatId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v)
const object = (raw: unknown): Record<string, unknown> | null =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const optionalText = (v: unknown, max: number): boolean => v === undefined || text(v, max)
const tab = (v: unknown): boolean => v === undefined || (Number.isSafeInteger(v) && Number(v) >= 0)
function history(raw: unknown): ChatTurn[] | undefined | null {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > 160) return null
  const turns: ChatTurn[] = []
  for (const value of raw) {
    const t = object(value)
    if (!t || (t.role !== 'user' && t.role !== 'assistant') || !text(t.content, 20000)) return null
    turns.push({ role: t.role, content: t.content })
  }
  return turns
}
function attachmentValid(r: Record<string, unknown>): boolean {
  if (!optionalText(r.pageText, 100000) || !tab(r.tabId)) return false
  if (r.imageDataUrl === undefined) return true
  return (
    text(r.imageDataUrl, 2500000) &&
    /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(r.imageDataUrl)
  )
}
export function parseChatStart(raw: unknown): ChatStart | null {
  const r = object(raw)
  if (!r || !validChatId(r.runId) || !validChatId(r.conversationId)) return null
  if (!text(r.prompt, 20000) || !r.prompt.trim()) return null
  if (r.mode !== 'chat' && r.mode !== 'agent' && r.mode !== 'image') return null
  const turns = history(r.history)
  if (turns === null || !attachmentValid(r)) return null
  // AES-GCM plus base64 must still fit the bridge's 4 MB HTTP body limit.
  if (JSON.stringify(r).length > 2800000) return null
  return {
    runId: r.runId,
    conversationId: r.conversationId,
    prompt: r.prompt,
    mode: r.mode,
    branch: r.branch === true,
    history: turns,
    pageText: r.pageText as string | undefined,
    imageDataUrl: r.imageDataUrl as string | undefined,
    tabId: r.tabId as number | undefined
  }
}
export function parseChatRead(raw: unknown): ChatRead | null {
  const r = object(raw)
  if (!r || !validChatId(r.runId) || !validChatId(r.conversationId)) return null
  if (
    !Number.isSafeInteger(r.cursor) ||
    Number(r.cursor) < 0 ||
    typeof r.done !== 'boolean' ||
    !Array.isArray(r.events)
  )
    return null
  const turns = history(r.history)
  if (turns === null || !optionalText(r.prompt, 20000) || !tab(r.tabId)) return null
  return {
    runId: r.runId,
    conversationId: r.conversationId,
    cursor: Number(r.cursor),
    done: r.done,
    events: r.events,
    prompt: r.prompt as string | undefined,
    history: turns,
    tabId: r.tabId as number | undefined
  }
}
