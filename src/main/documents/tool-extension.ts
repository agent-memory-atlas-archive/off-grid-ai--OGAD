// Document tools for models that use tools (Jan's retrieve + get_chunks, LibreChat's file_search):
// the answer's own passages come first; these let the model look further — another part of a
// book, or exact pages. Offered only on turns whose conversation has documents (toolChat adds the
// schemas), so other turns do not pay for them.

import type { ToolExtension } from '../tools'
import { documentStore, documentTurns } from '.'

const SEARCH = 'search_documents'
const READ = 'read_pages'
/** A tool result stays small enough to leave room for the answer. */
const MAX_CHARS = 6_000

export const documentToolSchemas = [
  {
    type: 'function',
    function: {
      name: SEARCH,
      description:
        'Search the documents attached to this chat for passages about something. Returns passages with their page numbers.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for.' },
          document: {
            type: 'string',
            description: 'Optional: part of a document name to search only that file.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: READ,
      description: 'Read specific pages of a document attached to this chat, e.g. pages 40 to 42.',
      parameters: {
        type: 'object',
        properties: {
          document: { type: 'string', description: 'Part of the document name.' },
          from: { type: 'number', description: 'First page.' },
          to: { type: 'number', description: 'Last page (at most 5 pages after the first).' }
        },
        required: ['document', 'from']
      }
    }
  }
]

function where(label: string | undefined, page: number): string {
  return label ?? `p. ${page}`
}

export const documentToolExtension: ToolExtension = {
  id: 'attached-documents',
  category: 'tool',
  // Added per turn by toolChat when the conversation has documents, never from the shared list.
  schemas: () => [],
  canHandle: (name) => name === SEARCH || name === READ,
  isReadOnlyTool: () => true,
  async execute(name, args, context) {
    const conversationId = context?.conversationId
    if (name === SEARCH) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return 'Give a query to search for.'
      const passages = await documentTurns.searchPassages(conversationId, query, {
        limit: 6,
        ...(typeof args.document === 'string' && args.document.trim()
          ? { documentName: args.document.trim() }
          : {})
      })
      if (!passages.length) return `Nothing in the attached documents matches "${query}".`
      return passages
        .map(
          (passage) => `(${passage.name}, ${where(passage.label, passage.page)})\n${passage.text}`
        )
        .join('\n\n---\n\n')
        .slice(0, MAX_CHARS)
    }
    const wanted = typeof args.document === 'string' ? args.document.trim().toLowerCase() : ''
    const from = Math.max(1, Math.floor(Number(args.from) || 1))
    const to = Math.min(from + 5, Math.max(from, Math.floor(Number(args.to) || from)))
    const sources = await documentTurns.documentsFor(conversationId, [])
    const source =
      sources.find((candidate) => candidate.name.toLowerCase().includes(wanted)) ?? sources[0]
    if (!source) return 'No documents are attached to this chat.'
    const pages = (await documentStore.readPages(source.id)).filter(
      (page) => page.page >= from && page.page <= to
    )
    if (!pages.length) return `${source.name} has no pages ${from}–${to}.`
    return pages
      .map((page) =>
        page.needsOcr && !page.text.trim()
          ? `[${source.name}, ${where(page.label, page.page)}] (scanned page, not read yet)`
          : `[${source.name}, ${where(page.label, page.page)}]\n${page.text.trim()}`
      )
      .join('\n\n')
      .slice(0, MAX_CHARS)
  },
  systemHint: () =>
    'search_documents and read_pages look further into the documents attached to this chat when the passages given are not enough.'
}
