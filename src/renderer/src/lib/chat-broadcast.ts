// Split-view "send to all panes": the first pane's composer, shown in the shared slot under the
// grid, sends its prompt itself and publishes it; every other pane sends it too, so each pane's
// model answers the same question.

import { useSyncExternalStore } from 'react'

export const SHARED_COMPOSER_SLOT_ID = 'chat-shared-composer-slot'

type Listener = (from: string, text: string) => void

const listeners = new Set<Listener>()

export function publishChatBroadcast(from: string, text: string): void {
  for (const listener of listeners) listener(from, text)
}

export function subscribeChatBroadcast(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// The shared composer's Stop stops every pane, and shows while any pane is still answering.
const stopListeners = new Set<() => void>()

export function publishChatStop(): void {
  for (const listener of stopListeners) listener()
}

export function subscribeChatStop(listener: () => void): () => void {
  stopListeners.add(listener)
  return () => stopListeners.delete(listener)
}

const generatingPanes = new Set<string>()
const generatingListeners = new Set<() => void>()

export function reportPaneGenerating(paneKey: string, generating: boolean): void {
  if (generatingPanes.has(paneKey) === generating) return
  if (generating) generatingPanes.add(paneKey)
  else generatingPanes.delete(paneKey)
  for (const listener of generatingListeners) listener()
}

export function useAnyPaneGenerating(): boolean {
  return useSyncExternalStore(
    (listener) => {
      generatingListeners.add(listener)
      return () => generatingListeners.delete(listener)
    },
    () => generatingPanes.size > 0
  )
}
