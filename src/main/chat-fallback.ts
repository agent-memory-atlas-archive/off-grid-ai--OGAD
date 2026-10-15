// Applies the shared chat fallback policy (@offgrid/models nextChatFallbackStep): a request that
// does not fit or was refused fails once; a server that could not answer is retried on the same
// model, then on at most one other local model, with one notice. It no longer walks every
// installed model and remote server.

import { nextChatFallbackStep, type ChatFailureKind } from '@offgrid/models'
import { ModelServerError } from './llm/http-post'
import { parseRemoteVisionModelId } from '../shared/remote-vision-server'

function failureKind(error: unknown): ChatFailureKind {
  if (error instanceof ModelServerError) return error.kind
  if (error instanceof Error && error.name === 'AbortError') return 'aborted'
  return 'unknown'
}

async function localAlternatives(): Promise<string[]> {
  const models = await import('./models-manager')
  const selected = models.getActiveModel()
  return (await models.getStorageInfo()).models
    .filter((model) => (model.kind === 'text' || model.kind === 'vision') && model.id !== selected)
    .map((model) => model.id)
    .filter((id) => !parseRemoteVisionModelId(id))
}

async function selectedName(): Promise<string> {
  const models = await import('./models-manager')
  const { getRemoteVisionServerSettings } = await import('./vision/remote-vision-server')
  const remote = getRemoteVisionServerSettings()
  const selectedRemote = remote.servers.find((server) => server.id === remote.activeServerId)
  return selectedRemote?.model ?? models.getActiveModel() ?? 'Selected model'
}

/** Retry a failed model round without re-running any tool call that already started. */
export async function runChatWithFallback<T>(
  run: () => Promise<T>,
  options: {
    signal?: AbortSignal
    canRetry?: () => boolean
    onModelChanged?: (failed: string, next: string) => void
  } = {}
): Promise<{ result: T; modelName?: string }> {
  let failures = 0
  let modelName: string | undefined
  for (;;) {
    try {
      const result = await run()
      return modelName ? { result, modelName } : { result }
    } catch (error) {
      if (options.signal?.aborted || options.canRetry?.() === false) throw error
      failures++
      const kind = failureKind(error)
      const step = nextChatFallbackStep({
        kind,
        failures,
        localAlternatives: failures === 2 && kind !== 'overflow' ? await localAlternatives() : []
      })
      if (step.action === 'fail') throw error
      if (step.action === 'retry-same') continue
      const models = await import('./models-manager')
      const failed = await selectedName()
      let activated = false
      try {
        activated = (await models.activateModel(step.to, 'text')).success
      } catch {
        activated = false
      }
      if (!activated || options.signal?.aborted) throw error
      options.onModelChanged?.(failed, step.to)
      modelName = step.to
    }
  }
}
