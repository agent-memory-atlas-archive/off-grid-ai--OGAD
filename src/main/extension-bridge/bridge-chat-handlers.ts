import { parseChatStart, validChatId, type ChatRequest } from './bridge-chat'

type Handler<Browser> = (params: Record<string, unknown>, browser: Browser) => Promise<unknown>
export function chatHandlers<Browser>(
  execute: ((request: ChatRequest, browser: Browser) => Promise<unknown>) | undefined
): Record<'chat.start' | 'chat.read' | 'chat.stop', Handler<Browser>> {
  const chat = (request: ChatRequest, browser: Browser): Promise<unknown> => {
    if (!execute) throw new Error('chat_unavailable')
    return execute(request, browser)
  }
  return {
    'chat.start': async (p, browser) => {
      const input = parseChatStart(p)
      if (!input) throw new Error('invalid')
      return chat({ action: 'start', input }, browser)
    },
    'chat.read': async (p, browser) => {
      if (!validChatId(p.runId) || !Number.isSafeInteger(p.cursor) || Number(p.cursor) < 0)
        throw new Error('invalid')
      return chat({ action: 'read', runId: p.runId, cursor: Number(p.cursor) }, browser)
    },
    'chat.stop': async (p, browser) => {
      if (!validChatId(p.runId)) throw new Error('invalid')
      return chat({ action: 'stop', runId: p.runId }, browser)
    }
  }
}
