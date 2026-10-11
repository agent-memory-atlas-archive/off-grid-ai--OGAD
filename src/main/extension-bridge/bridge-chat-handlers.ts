import { parseChatStart, validChatId, type ChatRequest } from './bridge-chat'
import type { BridgeData, PairedBrowser } from './bridge-service'

type Handler = (params: Record<string, unknown>, browser: PairedBrowser) => Promise<unknown>
export function chatHandlers(
  data: BridgeData
): Record<'chat.start' | 'chat.read' | 'chat.stop', Handler> {
  const chat = (request: ChatRequest, browser: PairedBrowser): Promise<unknown> => {
    if (!data.chat) throw new Error('chat_unavailable')
    return data.chat(request, browser)
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
