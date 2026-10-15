/**
 * A knowledge-base file moving between this device and a paired one.
 *
 * Sync (pro) publishes these on `projects:document-transfer`; the knowledge-base list reads them to
 * draw "Receiving from iPhone · 40%" or "Couldn't sync to iPhone: file too large". The free build has
 * no sync, so nothing is published and the list draws no transfer rows.
 */
export const PROJECT_DOCUMENT_TRANSFER_EVENT = 'projects:document-transfer'
/** Invoke: the transfers this device knows about now, for a list that opens mid-transfer. */
export const PROJECT_DOCUMENT_TRANSFERS_SNAPSHOT = 'projects:document-transfers'
/** Invoke: forget a failed transfer the person has read. */
export const PROJECT_DOCUMENT_TRANSFER_DISMISS = 'projects:dismiss-document-transfer'

type ProjectDocumentTransferStatus = 'active' | 'completed' | 'failed' | 'cancelled'

/** Why a transfer stopped, as one plain reason the row can say. */
type ProjectDocumentTransferFailure =
  | 'too_large'
  | 'unsupported'
  | 'checksum'
  | 'project_missing'
  | 'offline'
  | 'failed'

export interface ProjectDocumentTransfer {
  projectId: string
  syncId: string
  fileName: string
  direction: 'send' | 'receive'
  deviceId: string
  deviceName: string
  bytesTransferred: number
  totalBytes: number
  status: ProjectDocumentTransferStatus
  /** The transfer's own reason, kept for the tooltip. */
  error?: string
  failure?: ProjectDocumentTransferFailure
}

/** Identity of one transfer: one file, one peer, one direction. */
export const projectDocumentTransferKey = (
  transfer: Pick<ProjectDocumentTransfer, 'direction' | 'deviceId' | 'syncId'>
): string => `${transfer.direction}:${transfer.deviceId}:${transfer.syncId}`

/** Read a transfer error into the one reason a person can act on. */
export function classifyProjectDocumentTransferFailure(
  error: string | undefined
): ProjectDocumentTransferFailure {
  const text = (error ?? '').toLowerCase()
  if (/exceeds|too large|size limit/.test(text)) return 'too_large'
  if (/checksum|verify|incomplete|out-of-order|invalid chunk/.test(text)) return 'checksum'
  if (/project/.test(text)) return 'project_missing'
  if (/invalid request|metadata|unsupported|mime/.test(text)) return 'unsupported'
  if (/disconnect|not connected|timed out|stopped/.test(text)) return 'offline'
  return 'failed'
}

const FAILURE_WORDS: Record<ProjectDocumentTransferFailure, string> = {
  too_large: 'file too large',
  unsupported: 'file type not supported',
  checksum: 'file arrived damaged',
  project_missing: 'project missing',
  offline: 'device went offline',
  failed: 'transfer failed'
}

export function projectDocumentTransferPercent(transfer: ProjectDocumentTransfer): number {
  if (transfer.status === 'completed') return 100
  if (!transfer.totalBytes) return 0
  return Math.min(100, Math.round((100 * transfer.bytesTransferred) / transfer.totalBytes))
}

/** The short line a knowledge-base row shows for a transfer. */
export function projectDocumentTransferLabel(transfer: ProjectDocumentTransfer): string {
  const send = transfer.direction === 'send'
  if (transfer.status === 'failed') {
    const reason = FAILURE_WORDS[transfer.failure ?? 'failed']
    return `Couldn't sync ${send ? 'to' : 'from'} ${transfer.deviceName}: ${reason}`
  }
  const verb = send ? 'Sending to' : 'Receiving from'
  return `${verb} ${transfer.deviceName} · ${projectDocumentTransferPercent(transfer)}%`
}
