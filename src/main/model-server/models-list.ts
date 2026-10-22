// Pure transforms for the /v1/models response. No I/O. Extracted from
// model-server.ts so the capability -> kind tagging, the model-entry builder,
// and the ollama-style mirror are unit-testable. The handler still does the
// actual upstream fetch + active-model lookups; it feeds the results here.

import { detectThinkingDialect } from '../llm/thinking-dialect'

/** Tag an upstream LLM entry chat vs vision from its advertised capabilities. */
export function tagLlmEntry(m: Record<string, unknown>): Record<string, unknown> {
  const caps = Array.isArray(m.capabilities) ? (m.capabilities as string[]) : []
  return { ...m, kind: caps.includes('multimodal') || caps.includes('vision') ? 'vision' : 'chat' }
}

/** Tag every upstream LLM entry. */
export function tagLlmEntries(upData: Record<string, unknown>[]): Record<string, unknown>[] {
  return upData.map(tagLlmEntry)
}

/** Build a canonical /v1/models entry for a non-LLM modality pick. */
export function modelEntry(
  id: string,
  kind: string,
  now: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { id, object: 'model', created: now, owned_by: 'off-grid', kind, ...extra }
}

/** Mirror the canonical data list into the ollama-style `models` array. */
export function ollamaMirror(data: Record<string, unknown>[]): Record<string, unknown>[] {
  return data.map((m) => ({ name: m.id, model: m.id, type: 'model', kind: m.kind }))
}

export function specialistModelEntries(
  catalog: readonly { id: string; name: string; kind: string; tags?: readonly string[] }[],
  installed: readonly string[],
  now: number
): Record<string, unknown>[] {
  return catalog
    .filter((model) => model.kind === 'computer_use' && installed.includes(model.id))
    .map((model) =>
      // Declared for what they are, so no client lists a specialist as a chat model.
      modelEntry(model.id, model.tags?.includes('Decision') ? 'decision_specialist' : 'grounding_specialist', now, {
        name: model.name,
        ...(model.tags?.includes('Decision') ? {} : { capabilities: ['vision'] }),
        architecture: {
          input_modalities: model.tags?.includes('Decision') ? ['text'] : ['text', 'image'],
          output_modalities: model.tags?.includes('Decision') ? ['decisions'] : ['text']
        }
      })
    )
}

/** Complete installed chat models can be selected independently of the active pick. */
export function installedTextModelEntries(
  catalog: readonly { id: string; name: string; kind: string; remoteServerId?: string }[],
  installed: readonly string[], now: number
): Record<string, unknown>[] {
  return catalog.filter((model) => !model.remoteServerId &&
    (model.kind === 'text' || model.kind === 'vision') && installed.includes(model.id)
  ).map((model) => modelEntry(model.id, model.kind === 'vision' ? 'vision' : 'chat', now, {
    name: model.name
  }))
}

/** The loaded model's capabilities, read from the llama-server /props payload the same way a
 *  client probing /props reads them. null when the payload carries no capability data, so the
 *  entry stays unknown and clients probe for themselves. */
export function liveChatCapabilities(props: Record<string, unknown>): string[] | null {
  const modalities = props.modalities as { vision?: unknown } | undefined
  const templateCaps = props.chat_template_caps as { supports_tools?: unknown } | undefined
  if (!modalities && !templateCaps) return null
  const template = typeof props.chat_template === 'string' ? props.chat_template : undefined
  return [
    ...(modalities?.vision === true ? ['vision'] : []),
    ...(templateCaps?.supports_tools === true ? ['tools'] : []),
    ...(detectThinkingDialect(template) !== 'none' ? ['reasoning'] : [])
  ]
}

/** The saved chat model leads, marked active, so clients that take the first entry keep the user's
 *  choice; every local chat entry carries the context window the local engine serves, and only
 *  the loaded model carries capabilities (its live ones). */
export function leadWithActiveChatModel(
  entries: readonly Record<string, unknown>[],
  activeId: string | null,
  contextLength: number,
  loaded: { id: string; capabilities: string[] } | null = null
): Record<string, unknown>[] {
  const marked = entries.map((entry) => ({
    ...entry,
    context_length: contextLength,
    ...(activeId !== null && entry.id === activeId ? { active: true } : {}),
    ...(loaded && entry.id === loaded.id ? { capabilities: loaded.capabilities } : {})
  }))
  return [
    ...marked.filter((entry) => entry.active === true),
    ...marked.filter((entry) => entry.active !== true)
  ]
}

/** Every installed image model can be selected; the active pick leads so it stays the default. */
export function installedImageModelEntries(
  installed: readonly string[],
  active: string | null,
  now: number
): Record<string, unknown>[] {
  const ids = active ? [active, ...installed.filter((id) => id !== active)] : [...installed]
  return ids.map((id) => modelEntry(id, 'image', now))
}
