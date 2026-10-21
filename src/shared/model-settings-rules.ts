import { modelSupportsKind } from '@offgrid/models'
import { isStagedDecisionModel } from './task-model-rules'

/** Desktop Models tab membership, including vision models on Text. A decision model staged for
 *  evaluation is a task specialist, not a chat model, so it never shows as one. */
export function modelShowsOnTab(
  model: { id: string; kind: string; grounder?: boolean; files?: readonly { name: string }[] },
  tab: string
): boolean {
  return (
    !model.id.endsWith('+MTP') &&
    !isStagedDecisionModel(model) &&
    (modelSupportsKind(
      model as Parameters<typeof modelSupportsKind>[0],
      tab as Parameters<typeof modelSupportsKind>[1]
    ) ||
      (tab === 'text' &&
        modelSupportsKind(model as Parameters<typeof modelSupportsKind>[0], 'vision')))
  )
}

/** Agent uses Desktop's tool planner preflight, including its JSON fallback for local models. */
export function activeTextAvailability(
  active: { vision: boolean } | null,
  plannerReason: string | null,
  toolsEnabled: boolean
): { vision: boolean; agent: boolean; reasonIfNot?: string } {
  const reason = !active
    ? 'No active text model.'
    : !toolsEnabled
      ? 'Tools are disabled.'
      : plannerReason
  return {
    vision: active?.vision ?? false,
    agent: !reason,
    ...(reason ? { reasonIfNot: reason } : {})
  }
}

/** Remote vision is advertised by the saved Desktop model catalog, never inferred from a name. */
export function remoteTextVision(
  model: { inputModalities?: readonly string[] } | undefined
): boolean {
  return model?.inputModalities?.includes('image') === true
}
