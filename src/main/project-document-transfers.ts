import type { ProjectDocumentTransfer } from '../shared/project-document-transfer'

/**
 * Pro owns device sync. Core owns only this narrow read port, so the knowledge-base list can ask
 * what is moving when it opens. With no sync registered (the free build) there is nothing to show.
 */
interface ProjectDocumentTransferSource {
  snapshot(projectId: string): ProjectDocumentTransfer[]
  dismiss(key: string): void
}

let source: ProjectDocumentTransferSource | null = null

export function registerProjectDocumentTransferSource(
  next: ProjectDocumentTransferSource | null
): void {
  source = next
}

export function projectDocumentTransfers(projectId: string): ProjectDocumentTransfer[] {
  return source?.snapshot(projectId) ?? []
}

export function dismissProjectDocumentTransfer(key: string): void {
  source?.dismiss(key)
}
