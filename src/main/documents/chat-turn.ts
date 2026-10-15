// The chat turn's view of attached documents: runs the shared turn service with this machine's
// measured reading speed, reports progress in the work timeline, and turns the passages the model
// may cite into the turn's sources (`[S#]` → the Sources panel and citation pills).

import type {
  DocumentBudgetInput,
  DocumentSource,
  DocumentTurnSummary
} from '@offgrid/rag/documents'
import type { SearchResult } from '../../shared/search-contract'
import { attachmentSource } from './conversation-documents'
import {
  documentPrefillRate,
  documentTurns,
  previousDocumentSources,
  rememberDocumentSources
} from '.'

export type TurnDocumentRef = {
  documentId?: string
  name: string
  kind: string
  text?: string
  path?: string
}

export type DocumentsActivity = {
  kind: 'documents'
  label: string
  documents?: DocumentTurnSummary[]
}

export interface TurnDocuments {
  stable: string
  turn: string
  /** In citation order: `[S1]` is the first. */
  sources: SearchResult[]
  documents: DocumentTurnSummary[]
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export async function prepareTurnDocuments(input: {
  conversationId?: string
  current: TurnDocumentRef[]
  question: string
  history: { role: string; content: string }[]
  budget: Omit<DocumentBudgetInput, 'prefillTokensPerSecond' | 'remote'>
  onActivity?: (activity: DocumentsActivity) => void
}): Promise<TurnDocuments | null> {
  const current: DocumentSource[] = []
  for (const ref of input.current) {
    const source = await attachmentSource(ref)
    if (source) current.push(source)
  }
  const sources = await documentTurns.documentsFor(input.conversationId, current)
  if (!sources.length) return null
  input.onActivity?.({ kind: 'documents', label: `Reading ${plural(sources.length, 'document')}…` })
  const { getActiveRemoteVisionServer } = await import('../vision/remote-vision-server')
  const result = await documentTurns.prepare({
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    current,
    question: input.question,
    previousQuestions: input.history
      .filter((turn) => turn.role === 'user')
      .map((turn) => turn.content)
      .slice(-2),
    previousSources: previousDocumentSources(input.conversationId),
    budget: {
      ...input.budget,
      prefillTokensPerSecond: documentPrefillRate(),
      remote: !!getActiveRemoteVisionServer()
    }
  })
  if (!result) return null
  rememberDocumentSources(input.conversationId, result.usedKeys)
  const passages = result.documents.reduce((sum, document) => sum + document.passages, 0)
  input.onActivity?.({
    kind: 'documents',
    label:
      result.mode === 'whole'
        ? `Read ${plural(result.documents.length, 'document')} in full`
        : `Read ${plural(result.documents.length, 'document')} · ${plural(passages, 'passage')}`,
    documents: result.documents
  })
  return {
    stable: result.stable,
    turn: result.turn,
    documents: result.documents,
    sources: result.sources.map((source) => ({
      key: `attachment:${source.documentId}:${source.page}:${source.position}`,
      kind: 'attachment',
      refId: source.page,
      title: `${source.name} · ${source.label ?? `p. ${source.page}`}`,
      snippet: source.snippet,
      surface: source.name,
      url: null,
      ts: 0,
      imagePath: null,
      score: 0
    }))
  }
}
