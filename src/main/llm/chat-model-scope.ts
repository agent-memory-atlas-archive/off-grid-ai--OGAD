import { AsyncLocalStorage } from 'node:async_hooks'
import type { RemoteTextModelConnection } from './remote-chat-types'

const scopes = new AsyncLocalStorage<Readonly<RemoteTextModelConnection>>()

/** Run one chat turn on its own remote model (a split-view pane), whatever model is active. */
export function runWithChatModel<T>(
  model: RemoteTextModelConnection | null,
  task: () => Promise<T>
): Promise<T> {
  return model ? scopes.run(Object.freeze({ ...model }), task) : task()
}

export function currentChatModel(): Readonly<RemoteTextModelConnection> | undefined {
  return scopes.getStore()
}
