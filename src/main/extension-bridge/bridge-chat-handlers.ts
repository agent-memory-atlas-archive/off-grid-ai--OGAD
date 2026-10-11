import {
  AUTOMATION_TASK_CONTROL_INTENTS,
  type AutomationTaskControlIntent
} from '@offgrid/automation'
import { parseChatStart, validChatId, type ChatRequest } from './bridge-chat'
import { TASK_GUIDE_MAX_TEXT_CHARS } from '../../shared/task-guidance'

const isControlIntent = (v: unknown): v is AutomationTaskControlIntent =>
  (AUTOMATION_TASK_CONTROL_INTENTS as readonly unknown[]).includes(v)

type Handler<Browser> = (params: Record<string, unknown>, browser: Browser) => Promise<unknown>
export function chatHandlers<Browser>(
  execute: ((request: ChatRequest, browser: Browser) => Promise<unknown>) | undefined
): Record<
  'chat.start' | 'chat.read' | 'chat.stop' | 'chat.control' | 'chat.guide',
  Handler<Browser>
> {
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
    },
    'chat.control': async (p, browser) => {
      if (!validChatId(p.runId) || !isControlIntent(p.intent)) throw new Error('invalid')
      return chat({ action: 'control', runId: p.runId, intent: p.intent }, browser)
    },
    'chat.guide': async (p, browser) => {
      if (!validChatId(p.runId) || typeof p.text !== 'string' || !p.text.trim()) {
        throw new Error('invalid')
      }
      if (p.text.length > TASK_GUIDE_MAX_TEXT_CHARS) throw new Error('invalid')
      return chat({ action: 'guide', runId: p.runId, text: p.text }, browser)
    }
  }
}
