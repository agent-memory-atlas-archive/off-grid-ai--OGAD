// Composition root for documents (chat attachments and project knowledge bases): the shared ingest
// and turn services (@offgrid/rag/documents) wired to desktop's adapters. No rules live here.

import { BrowserWindow } from 'electron'
import { estimateTextTokens } from '@offgrid/models'
import {
  DocumentIngestService,
  DocumentTurnService,
  type DocumentProgress,
  type DocumentSource,
  type Scheduler
} from '@offgrid/rag/documents'
import { documentExtractor } from './extract'
import { documentKeywordSearch, documentStore } from './sqlite-store'
import { documentEmbedder, documentReranker } from './models'
import { conversationDocuments, referencedDocumentIds } from './conversation-documents'
import { knowledgeBaseDocumentIds, projectDocuments } from './project-documents'
import { pageOcr, shutdownOcr } from './ocr'

/** Foreground work (a chat reply, an image, speech) is running or waiting to run. */
async function foregroundBusy(): Promise<boolean> {
  const { modalityQueue } = await import('../modality-queue/queue')
  const { running, queued } = modalityQueue.getState()
  return [...running, ...queued].some((job) => job.tier < 3)
}

/**
 * Background indexing waits while the user is waiting on something, so it never slows an answer.
 * It does not wait for other background passes (ambient capture runs them almost constantly).
 */
const scheduler: Scheduler = {
  async yieldToForeground() {
    while (await foregroundBusy()) await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

const lastSent = new Map<string, { phase: string; at: number }>()

/** Progress to every window, at most a few times a second per document (phase changes always). */
function broadcast(progress: DocumentProgress): void {
  const previous = lastSent.get(progress.id)
  const now = Date.now()
  if (previous && previous.phase === progress.phase && now - previous.at < 250) return
  lastSent.set(progress.id, { phase: progress.phase, at: now })
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('documents:progress', progress)
  }
}

const warn = (message: string, error: unknown): void => {
  console.warn(`[documents] ${message}:`, error instanceof Error ? error.message : error)
}

export const documentIngest = new DocumentIngestService({
  extract: documentExtractor,
  store: documentStore,
  scheduler,
  embed: documentEmbedder,
  ocr: pageOcr,
  onProgress: broadcast,
  onWarning: warn
})

export const documentTurns = new DocumentTurnService({
  ingest: documentIngest,
  store: documentStore,
  conversations: conversationDocuments,
  projects: projectDocuments,
  keyword: documentKeywordSearch,
  embed: documentEmbedder,
  rerank: documentReranker,
  countTokens: estimateTextTokens,
  onWarning: warn
})

/** Start reading a document right after it is attached; the turn finds it indexed or indexing. */
export function startDocumentIngest(source: DocumentSource): void {
  void documentIngest.ingest(source)
}

/** Unused caches are deleted after this long. */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/** Documents a conversation or a knowledge base still uses. */
async function documentsInUse(): Promise<Set<string>> {
  const used = await referencedDocumentIds()
  for (const id of await knowledgeBaseDocumentIds()) used.add(id)
  return used
}

/** Drop document caches nothing references and that went unused for 30 days. */
export async function collectDocumentGarbage(): Promise<void> {
  try {
    await documentIngest.collectGarbage(await documentsInUse(), CACHE_MAX_AGE_MS)
  } catch (error) {
    warn('Cleaning document caches failed', error)
  }
}

/** A conversation or knowledge-base file was deleted: drop documents nothing else uses, now. */
export async function forgetUnreferencedDocuments(): Promise<void> {
  try {
    await documentIngest.collectGarbage(await documentsInUse(), 0)
  } catch (error) {
    warn('Removing documents of a deleted chat failed', error)
  }
}

export async function shutdownDocuments(): Promise<void> {
  documentIngest.shutdown()
  await Promise.all([documentExtractor.shutdown(), shutdownOcr()])
}

export { documentStore }

/**
 * Prompt-reading speed of the local model, measured on real (long) prompts. It sets how much of a
 * document the first answer reads (shared documentBudget). Smoothed, so one slow run does not swing it.
 */
let measuredPrefill: number | undefined

export function noteDocumentPrefill(metrics?: {
  prefillTokensPerSecond?: number
  promptTokens?: number
}): void {
  const rate = metrics?.prefillTokensPerSecond
  // Short prompts measure overhead more than reading speed.
  if (!rate || !Number.isFinite(rate) || (metrics.promptTokens ?? 0) < 1_500) return
  measuredPrefill = measuredPrefill ? measuredPrefill * 0.7 + rate * 0.3 : rate
}

export function documentPrefillRate(): number | undefined {
  return measuredPrefill
}

/** Passages each conversation's last answer used, for follow-ups ("tell me more"). */
const previousSources = new Map<string, string[]>()

export function rememberDocumentSources(conversationId: string | undefined, keys: string[]): void {
  if (!conversationId) return
  previousSources.delete(conversationId)
  previousSources.set(conversationId, keys)
  if (previousSources.size > 50) previousSources.delete(previousSources.keys().next().value!)
}

export function previousDocumentSources(conversationId: string | undefined): string[] | undefined {
  return conversationId ? previousSources.get(conversationId) : undefined
}
