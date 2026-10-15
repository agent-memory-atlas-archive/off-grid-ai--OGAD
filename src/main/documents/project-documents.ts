// ProjectDocumentsPort: a project's knowledge base as document sources. Every chat filed in the
// project uses these files alongside its own attachments; the rules are the shared turn service's.

import fs from 'node:fs'
import type { DocumentSource, ProjectDocumentsPort } from '@offgrid/rag/documents'
import type { RagDocument } from '@offgrid/rag'

/** Kinds the engine reads from the file itself; the rest are indexed from their transcript or caption. */
const FILE_KINDS = new Set(['pdf', 'docx', 'text'])

async function sourceFor(document: RagDocument): Promise<DocumentSource | null> {
  const { knowledgeBase } = await import('../rag')
  // A file added before files had document ids is indexed in the background; it joins later turns.
  const id = await knowledgeBase.documentIdFor(document, FILE_KINDS.has(document.kind))
  if (!id) return null
  const onDisk = FILE_KINDS.has(document.kind) && fs.existsSync(document.path)
  return {
    id,
    name: document.name,
    kind: onDisk ? document.kind : 'text',
    ...(onDisk ? { path: document.path } : {})
  }
}

export const projectDocuments: ProjectDocumentsPort = {
  async forConversation(conversationId) {
    const { projectOfConversation } = await import('../rag')
    const projectId = projectOfConversation(conversationId)
    return projectId ? projectDocuments.forProject(projectId) : []
  },
  async forProject(projectId) {
    const { listRagDocuments } = await import('../rag')
    const sources: DocumentSource[] = []
    // Oldest first, so the stable prompt block keeps its order as files are added.
    for (const document of listRagDocuments(projectId).reverse()) {
      if (!document.enabled) continue
      const source = await sourceFor(document)
      if (source) sources.push(source)
    }
    return sources
  }
}

/** Every document id a knowledge base holds, so cache cleanup never drops one. */
export async function knowledgeBaseDocumentIds(): Promise<Set<string>> {
  const { listAllRagDocuments } = await import('../rag')
  return new Set(listAllRagDocuments().flatMap((document) => (document.documentId ? [document.documentId] : [])))
}
