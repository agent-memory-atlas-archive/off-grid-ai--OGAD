// Team gateway mode's admission, one limiter per runtime, sized from the shared policy table
// (gatewayRuntimeTable in @offgrid/models). The HTTP gateway and the MCP server take turns through
// the same limiters, so a runtime's limit holds whichever door a request came in by.
//
// Single mode never touches these: every route keeps today's serialisation.

import { totalmem } from 'os'
import {
  EMBEDDING_BATCH_MAX,
  gatewayRuntimeTable,
  limiterQueueDepth,
  llmSlotCount,
  type GatewayRuntime
} from '@offgrid/models'
import { llm } from '../llm'
import { LimiterFullError, UpstreamLimiter, type Release } from './upstream-limiter'

/** The context the grounder and Decider llama-servers launch with. */
const SPECIALIST_CONTEXT = 16_384

/** Whether the gateway serves several clients at once. */
export function teamMode(): boolean {
  return llm.gatewayMode() === 'team'
}

const LABELS: Record<GatewayRuntime, string> = {
  chat: 'local model',
  grounder: 'grounding model',
  decision: 'decision model',
  kev: 'Kev decision model',
  remote: 'remote model',
  image: 'image model',
  transcription: 'transcription model',
  speech: 'voice model',
  embeddings: 'embedding model'
}

/** The concurrency each runtime gets right now (slots follow the chat model's settings). */
export function teamConcurrency(): Record<GatewayRuntime, number> {
  const totalRamGb = totalmem() / 1024 ** 3
  const table = gatewayRuntimeTable({
    chatSlots: llm.gatewaySlots(),
    specialistSlots: llmSlotCount({
      mode: 'team',
      ctxSize: SPECIALIST_CONTEXT,
      totalMemoryGb: totalRamGb
    }),
    totalRamGb
  })
  return Object.fromEntries(
    Object.entries(table).map(([runtime, row]) => [runtime, row.concurrency])
  ) as Record<GatewayRuntime, number>
}

const limiters = new Map<GatewayRuntime, UpstreamLimiter>()

/** The runtime's limiter, sized to its current concurrency. */
export function teamLimiter(runtime: GatewayRuntime): UpstreamLimiter {
  const capacity = teamConcurrency()[runtime]
  let limiter = limiters.get(runtime)
  if (!limiter) {
    limiter = new UpstreamLimiter(LABELS[runtime], capacity)
    limiters.set(runtime, limiter)
  } else limiter.setCapacity(capacity)
  return limiter
}

/** The chat model's limiter without resizing it (the eviction gate reads it at any time). */
export function chatLimiter(): UpstreamLimiter {
  let limiter = limiters.get('chat')
  if (!limiter) {
    limiter = new UpstreamLimiter(LABELS.chat, 1)
    limiters.set('chat', limiter)
  }
  return limiter
}

/** Run `work` on its turn. A request whose client leaves while waiting gives its place up. */
export async function withTurn<T>(
  runtime: GatewayRuntime,
  work: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const release: Release = await teamLimiter(runtime).acquire(signal)
  try {
    return await work()
  } finally {
    release()
  }
}

// ─── Embeddings: concurrent requests coalesce into one batch ────────────────

interface EmbeddingWaiter {
  texts: string[]
  resolve: (vectors: number[][]) => void
  reject: (error: unknown) => void
}

const embeddingWaiters: EmbeddingWaiter[] = []
let embeddingBatchRunning = false

/**
 * Vectors for `texts`, batched with every other request waiting at the time: the worker runs one
 * batch at a time, so requests that arrive while it is busy share the next forward pass instead of
 * queueing one by one. Interactive: these run ahead of background indexing. Refused (429) past the
 * bounded line.
 */
export function embedCoalesced(texts: string[]): Promise<number[][]> {
  if (embeddingWaiters.length >= limiterQueueDepth(1) * 4)
    return Promise.reject(new LimiterFullError(LABELS.embeddings))
  return new Promise<number[][]>((resolve, reject) => {
    embeddingWaiters.push({ texts, resolve, reject })
    void runEmbeddingBatch()
  })
}

async function runEmbeddingBatch(): Promise<void> {
  if (embeddingBatchRunning || embeddingWaiters.length === 0) return
  embeddingBatchRunning = true
  const batch: EmbeddingWaiter[] = []
  let size = 0
  while (embeddingWaiters.length > 0) {
    const next = embeddingWaiters[0]!
    if (batch.length > 0 && size + next.texts.length > EMBEDDING_BATCH_MAX) break
    batch.push(embeddingWaiters.shift()!)
    size += next.texts.length
  }
  try {
    const { embeddings } = await import('../embeddings')
    const vectors = await embeddings.embedDocumentTexts(
      batch.flatMap((waiter) => waiter.texts),
      { interactive: true, source: 'API embeddings' }
    )
    let offset = 0
    for (const waiter of batch) {
      waiter.resolve(vectors.slice(offset, offset + waiter.texts.length))
      offset += waiter.texts.length
    }
  } catch (error) {
    for (const waiter of batch) waiter.reject(error)
  } finally {
    embeddingBatchRunning = false
    void runEmbeddingBatch()
  }
}
