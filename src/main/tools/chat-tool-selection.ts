import { budgetTools, MAX_TOOL_TOKENS } from './tool-budget'

export async function selectChatToolSchemas(
  query: string | undefined,
  rawTools: unknown[],
  assistantRequiredTools: unknown[],
  options: {
    contextSize: number
    projectId?: string
    allMemory?: boolean
    imageAvailable?: boolean
    history?: { role: string; content: string }[]
  }
): Promise<{ tools: unknown[]; protectedToolCount: number; droppedCount: number }> {
  if (query === undefined) {
    return { tools: rawTools, protectedToolCount: assistantRequiredTools.length, droppedCount: 0 }
  }
  const imageAvailable = options.imageAvailable ?? false
  const history = options.history ?? []
  // Keep the tool payload within the model's context. llama-server inlines every
  // tool schema into the prompt AND compiles it to a grammar, so a big connector
  // set can blow past the context window and 400 the whole turn. Budget to a
  // fraction of the effective context (leaving room for system + history +
  // answer); prune verbose schemas first, drop connector tools only if needed.
  // Route every enabled built-in and connector through local MiniLM. The older
  // path ranked connectors only, and only when there were at least two of them;
  // all built-ins were sent on every turn. Selection now runs for any non-empty
  // catalog and sends only the tools pertinent to this message. If MiniLM cannot
  // load, the lexical fallback fails closed to direct matches.
  let relevantTools: unknown[] = []
  if (rawTools.length > 0) {
    const { selectRelevantTools } = await import('./tool-ranking')
    const lexicalTools = selectRelevantTools(query, rawTools)
    const namedTool = rawTools.some((schema) => {
      const name = (schema as { function?: { name?: unknown } }).function?.name
      return typeof name === 'string' && query.toLowerCase().includes(name.toLowerCase())
    })
    // An explicit tool name needs no semantic ranking. If image generation is unavailable,
    // an explicit generate_image request cannot be routed to that missing tool.
    const unavailableImageTool = !imageAvailable && /\bgenerate_image\b/i.test(query)
    if (!namedTool && !unavailableImageTool) {
      try {
        const { embeddings } = await import('../embeddings')
        const { contextualToolRoutingText, selectRelevantToolsSemantic } =
          await import('./tool-embedding-ranking')
        const routingText = contextualToolRoutingText(query, history)
        relevantTools = await selectRelevantToolsSemantic(routingText, rawTools, {
          embed: (t) => embeddings.generateEmbedding(t)
        })
      } catch {
        // The direct-match selection below remains available offline.
      }
    }
    // A semantic score must not hide a direct name or description match. This
    // also keeps explicit tool requests available when a new embedding model
    // ranks an unrelated schema first.
    relevantTools = [
      ...lexicalTools,
      ...relevantTools.filter((tool) => !lexicalTools.includes(tool))
    ]
  }
  const scopeToolName = options.projectId
    ? 'search_knowledge_base'
    : options.allMemory
      ? 'search_memory'
      : null
  const explicitlyNamedTools = rawTools.filter((schema) => {
    const name = (schema as { function?: { name?: unknown } }).function?.name
    return (
      typeof name === 'string' &&
      (name === scopeToolName || query.toLowerCase().includes(name.toLowerCase()))
    )
  })
  if (explicitlyNamedTools.length) {
    const explicitNames = new Set(explicitlyNamedTools)
    relevantTools = [
      ...explicitlyNamedTools,
      ...relevantTools.filter((schema) => !explicitNames.has(schema))
    ]
  }
  // Acting is offered whenever the assistant may act, and the model decides from the prompt
  // (answer questions; act when asked to do something on a website or in an app). Routing by the
  // words of the message must not hide it: "can you check this site?" shares no words with it.
  if (assistantRequiredTools.length) {
    const acting = new Set(assistantRequiredTools)
    relevantTools = [...assistantRequiredTools, ...relevantTools.filter((t) => !acting.has(t))]
  }
  if (!/\bbrave\b/i.test(query)) {
    const hasPrimarySearch = relevantTools.some(
      (schema) => (schema as { function?: { name?: unknown } }).function?.name === 'web_search'
    )
    if (hasPrimarySearch) {
      relevantTools = relevantTools.filter(
        (schema) => (schema as { function?: { name?: unknown } }).function?.name !== 'brave_search'
      )
    }
  }
  const protectedToolCount =
    explicitlyNamedTools.length +
    assistantRequiredTools.filter((t) => !explicitlyNamedTools.includes(t)).length
  const ctx = options.contextSize
  // Cap tool tokens in ABSOLUTE terms too, not just as a fraction of context:
  // llama-server re-processes the entire tool prompt every tool round (gemma-4's
  // sliding-window attention defeats the prompt cache), so on CPU-only inference a
  // large tool payload dominates latency. ~4k keeps a useful connector set while
  // roughly halving per-round prompt cost vs the old 45%-of-a-big-context budget.
  const toolBudget = Math.max(1024, Math.min(Math.floor(ctx * 0.4), MAX_TOOL_TOKENS))
  const budgeted = budgetTools(relevantTools, toolBudget, protectedToolCount)
  if (budgeted.pruned || budgeted.droppedCount) {
    console.warn(
      `[tools] context budget ${toolBudget} tok: pruned schemas${budgeted.droppedCount ? `, dropped ${budgeted.droppedCount} connector tool(s)` : ''} to fit (final ~${budgeted.estTokens} tok)`
    )
  }
  return { tools: budgeted.tools, protectedToolCount, droppedCount: budgeted.droppedCount }
}
