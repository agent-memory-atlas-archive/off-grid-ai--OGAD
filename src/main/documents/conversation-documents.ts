// ConversationDocumentsPort: every document attached anywhere in a conversation, read from the
// saved messages (their `context.attachments`). Documents belong to the conversation, so a
// follow-up question days later still sees them.

import crypto from 'node:crypto'
import fs from 'node:fs'
import type { ConversationDocumentsPort, DocumentSource } from '@offgrid/rag/documents'
import { getDB } from '../database'
import { excludedDocuments } from './sqlite-store'

/** Attachment kinds that are documents (images go to the vision model instead). */
const DOCUMENT_KINDS = new Set(['pdf', 'docx', 'text', 'pasted', 'audio', 'video'])

export type StoredAttachment = {
  name?: unknown
  kind?: unknown
  text?: unknown
  path?: unknown
  documentId?: unknown
}

export function hashText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Older messages carry no documentId: their file (or text) is hashed once per path and size. */
const legacyIds = new Map<string, string>()

async function legacyId(attachment: { path?: string; text?: string }): Promise<string | null> {
  if (attachment.path) {
    try {
      const stat = await fs.promises.stat(attachment.path)
      const key = `${attachment.path}:${stat.size}:${stat.mtimeMs}`
      const known = legacyIds.get(key)
      if (known) return known
      const id = await hashFile(attachment.path)
      legacyIds.set(key, id)
      return id
    } catch {
      /* the file is gone (another device, cleared uploads); fall back to its text */
    }
  }
  return attachment.text ? hashText(attachment.text) : null
}

/** A saved (or about-to-be-sent) attachment as a document source, or null if it is not one. */
export async function attachmentSource(
  attachment: StoredAttachment
): Promise<DocumentSource | null> {
  const kind = typeof attachment.kind === 'string' ? attachment.kind : ''
  if (!DOCUMENT_KINDS.has(kind)) return null
  const text =
    typeof attachment.text === 'string' && attachment.text.trim() ? attachment.text : undefined
  let filePath =
    typeof attachment.path === 'string' && attachment.path ? attachment.path : undefined
  // Audio and video are documents through their transcript; their file is the recording.
  if (kind === 'audio' || kind === 'video') filePath = undefined
  if (filePath && !fs.existsSync(filePath)) filePath = undefined
  if (!filePath && !text) return null
  const declared =
    typeof attachment.documentId === 'string' && attachment.documentId
      ? attachment.documentId
      : null
  const id = declared ?? (await legacyId({ path: filePath, text }))
  if (!id) return null
  const name = typeof attachment.name === 'string' && attachment.name ? attachment.name : 'Document'
  // Without the file (another device), the saved text is what can be read.
  const extractKind = filePath ? kind : 'text'
  return {
    id,
    name,
    kind: extractKind === 'pasted' ? 'text' : extractKind,
    ...(filePath ? { path: filePath } : {}),
    ...(!filePath && text ? { text } : {})
  }
}

export const conversationDocuments: ConversationDocumentsPort = {
  async list(conversationId) {
    const rows = getDB()
      .prepare(
        `SELECT context FROM rag_messages
         WHERE conversation_id = ? AND role = 'user' AND context LIKE '%"attachments"%'
         ORDER BY created_at ASC, id ASC`
      )
      .all(conversationId) as { context: string | null }[]
    const sources: DocumentSource[] = []
    for (const row of rows) {
      let attachments: StoredAttachment[] = []
      try {
        const context = JSON.parse(row.context ?? '{}') as { attachments?: unknown }
        if (Array.isArray(context.attachments))
          attachments = context.attachments as StoredAttachment[]
      } catch {
        continue
      }
      for (const attachment of attachments) {
        const source = await attachmentSource(attachment)
        if (source) sources.push(source)
      }
    }
    return sources
  },
  async excluded(conversationId) {
    return excludedDocuments(conversationId)
  }
}

/** Every document id still referenced by some conversation (for cache garbage collection). */
export async function referencedDocumentIds(): Promise<Set<string>> {
  const rows = getDB()
    .prepare(
      `SELECT DISTINCT conversation_id FROM rag_messages WHERE role = 'user' AND context LIKE '%"attachments"%'`
    )
    .all() as { conversation_id: string }[]
  const ids = new Set<string>()
  for (const { conversation_id } of rows) {
    for (const source of await conversationDocuments.list(conversation_id)) ids.add(source.id)
  }
  return ids
}
