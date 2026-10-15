import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-knowledge-sync-owner-'))

vi.mock('electron', () => ({
  app: { getPath: () => TMP_DIR, isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

import { getDB } from '../database'
import { HOOKS, registerHook } from '../bootstrap/hookRegistry'
import {
  knowledgeBase,
  deleteProject,
  ensureRagStoreSchema,
  listProjects,
  createProject
} from '../rag'
import { documentTurns } from '../documents'
import { configureRuntime } from '../runtime-env'
import type {
  KnowledgeDocumentMutation,
  KnowledgeDocumentSnapshot
} from '../sync-knowledge-document'

// The embedding model folder is pinned to a missing one: indexing skips vectors (the product's own
// "folder unavailable" path) and search runs on the real keyword index, with no download.
configureRuntime({ dataDir: TMP_DIR, modelsDir: path.join(TMP_DIR, 'model-folder-not-connected') })

const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const REMOTE_SYNC_ID = '33333333-3333-4333-8333-333333333333'

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('desktop knowledge-document sync owner', () => {
  it('migrates stable identity and suppresses lifecycle echo for synced imports', async () => {
    const db = getDB()
    db.exec(`
      CREATE TABLE rag_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'text',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO rag_documents (project_id, name, path, size, kind)
      VALUES ('legacy-project', 'legacy.txt', '/legacy.txt', 12, 'text');
    `)

    ensureRagStoreSchema()
    const legacy = db
      .prepare('SELECT sync_id FROM rag_documents WHERE name = ?')
      .get('legacy.txt') as { sync_id: string }
    expect(legacy.sync_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )

    createProject({ id: PROJECT_ID, name: 'Shared research' })
    expect(listProjects()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: PROJECT_ID })])
    )

    const mutations: KnowledgeDocumentMutation[] = []
    registerHook(HOOKS.syncKnowledgeDocumentMutation, (mutation: KnowledgeDocumentMutation) => {
      mutations.push(mutation)
    })
    const service = knowledgeBase

    const localPath = path.join(TMP_DIR, 'local-notes.txt')
    fs.writeFileSync(localPath, 'Local field notes contain enough text to produce one RAG chunk.')
    const indexed = await service.addFile({
      projectId: PROJECT_ID,
      path: localPath,
      fileName: 'local-notes.txt',
      size: fs.statSync(localPath).size
    })
    const local = service.listDocuments(PROJECT_ID).find((document) => document.id === indexed.id)
    expect(local?.syncId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    // Sync sends the copy the knowledge base keeps, which holds the same bytes as the picked file.
    expect(mutations).toEqual([
      {
        kind: 'indexed',
        document: expect.objectContaining({
          syncId: local?.syncId,
          projectId: PROJECT_ID,
          filePath: local?.path,
          enabled: true
        })
      }
    ])
    expect(fs.readFileSync(local!.path, 'utf8')).toBe(fs.readFileSync(localPath, 'utf8'))

    const shortPath = path.join(TMP_DIR, 'op.txt')
    fs.writeFileSync(shortPath, 'op\n')
    await service.addFile({
      projectId: PROJECT_ID,
      path: shortPath,
      fileName: 'op.txt',
      size: fs.statSync(shortPath).size
    })
    // Even a two-letter file is a passage every chat in the project reads.
    await vi.waitFor(async () => {
      const turn = await documentTurns.prepare({
        projectId: PROJECT_ID,
        current: [],
        question: 'What is in op.txt?',
        previousQuestions: [],
        budget: { ctx: 8192, replyReserve: 1024, systemTokens: 200, requiredToolTokens: 0, historyTokens: 0, questionTokens: 20 }
      })
      expect(`${turn?.stable}${turn?.turn}`).toMatch(/<document name="op\.txt"[^>]*>\n<source id="S\d+" (page="1"|at="part 1")>\nop\n<\/source>/)
    })

    await service.toggleDocument(indexed.id, false)
    expect(mutations.at(-1)).toEqual({
      kind: 'enabled',
      syncId: local?.syncId,
      enabled: false
    })

    const remotePath = path.join(TMP_DIR, 'remote-notes.txt')
    fs.writeFileSync(remotePath, 'Remote field notes also contain enough text for local indexing.')
    const remote: KnowledgeDocumentSnapshot = {
      syncId: REMOTE_SYNC_ID,
      projectId: PROJECT_ID,
      name: 'remote-notes.txt',
      filePath: remotePath,
      fileSize: fs.statSync(remotePath).size,
      createdAt: '2026-07-28T08:00:00.000Z',
      enabled: true
    }
    const mutationCount = mutations.length
    const remoteId = await service.indexSyncedDocument(remote)
    await service.setSyncedDocumentEnabled(REMOTE_SYNC_ID, false)
    expect(mutations).toHaveLength(mutationCount)
    expect(service.getDocumentBySyncId(REMOTE_SYNC_ID)).toMatchObject({
      id: remoteId,
      syncId: REMOTE_SYNC_ID,
      enabled: false
    })

    await service.deleteSyncedDocument(REMOTE_SYNC_ID)
    expect(service.getDocumentBySyncId(REMOTE_SYNC_ID)).toBeUndefined()
    expect(mutations).toHaveLength(mutationCount)

    await service.deleteDocument(indexed.id)
    expect(mutations.at(-1)).toEqual({ kind: 'deleted', syncId: local?.syncId })

    const projectDocumentPath = path.join(TMP_DIR, 'project-owned.txt')
    fs.writeFileSync(
      projectDocumentPath,
      'Deleting the project should publish this document tombstone after commit.'
    )
    const projectDocument = await service.addFile({
      projectId: PROJECT_ID,
      path: projectDocumentPath,
      fileName: 'project-owned.txt',
      size: fs.statSync(projectDocumentPath).size
    })
    const projectDocumentSyncId = service
      .listDocuments(PROJECT_ID)
      .find((document) => document.id === projectDocument.id)?.syncId

    deleteProject(PROJECT_ID)

    expect(service.getDocumentBySyncId(projectDocumentSyncId!)).toBeUndefined()
    expect(mutations.at(-1)).toEqual({
      kind: 'deleted',
      syncId: projectDocumentSyncId
    })
  })
})
