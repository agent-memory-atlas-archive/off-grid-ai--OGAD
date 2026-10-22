import { useCallback, useSyncExternalStore } from 'react'
import { applyStreamEvent, type StreamEvent } from '@renderer/lib/stream-reducer'
import type { ChatMessage } from './types'

const streamMessages = new Map<string, ChatMessage>()
const streamListeners = new Map<string, Set<() => void>>()

function notifyStream(streamId: string): void {
  for (const listener of streamListeners.get(streamId) ?? []) listener()
}

// Every repaint re-renders the whole answer so far (its Markdown parsed from the start), so token
// events repaint in batches. The gap grows with the answers on screen: one chat stays smooth, and
// six split-view panes streaming at once no longer saturate the renderer.
const PAINT_MS_PER_STREAM = 33
const pendingStreams = new Set<string>()
let paintTimer: ReturnType<typeof setTimeout> | null = null

function scheduleNotify(streamId: string): void {
  pendingStreams.add(streamId)
  if (paintTimer) return
  paintTimer = setTimeout(
    () => {
      paintTimer = null
      const ids = [...pendingStreams]
      pendingStreams.clear()
      for (const id of ids) notifyStream(id)
    },
    PAINT_MS_PER_STREAM * Math.max(1, streamListeners.size)
  )
}

export function seedStreamViewMessage(message: ChatMessage): void {
  streamMessages.set(message.id, message)
  notifyStream(message.id)
}

/** The live view of a stream, held for as long as its sender runs (it outlives a remount). */
export function streamViewMessage(streamId: string): ChatMessage | undefined {
  return streamMessages.get(streamId)
}

export function applyStreamViewEvent(streamId: string, event: StreamEvent): void {
  const current = streamMessages.get(streamId)
  if (!current) return
  streamMessages.set(streamId, applyStreamEvent(current, event) as ChatMessage)
  scheduleNotify(streamId)
}

export function resetStreamViewMessage(streamId: string): void {
  const current = streamMessages.get(streamId)
  if (!current) return
  streamMessages.set(streamId, {
    ...current,
    content: '',
    reasoning: '',
    timeline: [],
    toolCalls: [],
    activity: undefined
  })
  notifyStream(streamId)
}

export function clearStreamViewMessage(streamId: string): void {
  streamMessages.delete(streamId)
}

export function useStreamViewMessage(message: ChatMessage): ChatMessage {
  const streamId = message.streaming ? message.id : null
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!streamId) return () => undefined
      const listeners = streamListeners.get(streamId) ?? new Set<() => void>()
      listeners.add(listener)
      streamListeners.set(streamId, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) streamListeners.delete(streamId)
      }
    },
    [streamId]
  )
  const getSnapshot = useCallback(
    () => (streamId ? (streamMessages.get(streamId) ?? message) : message),
    [message, streamId]
  )

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
