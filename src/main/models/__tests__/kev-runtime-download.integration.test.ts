import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  KEV_4B_ID,
  downloadModel,
  listInstalled,
  resolveKevRuntimeArtifact,
  type DownloadProgress
} from '../../models-manager'
import { installedKevRuntimeRoot } from '../../kev-runtime-pack'
import {
  startKevRuntimeStore,
  type KevRuntimeStore
} from '../../__tests__/kev-runtime-store-fixture'

// The Mac app downloads Kev's Python runtime from the runtime store with the Kev model.
let store: KevRuntimeStore

beforeAll(async () => {
  store = await startKevRuntimeStore(
    fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kev-runtime-download-'))
  )
})
beforeEach(() => store.reset())
afterAll(() => store.close())

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')(
  'Kev runtime download with the Kev model',
  () => {
    it('installs the runtime in the same download job and resolves Kev to it', async () => {
      expect(resolveKevRuntimeArtifact(KEV_4B_ID)).toBeNull()
      const progress: DownloadProgress[] = []

      expect(await downloadModel(KEV_4B_ID, (event) => progress.push({ ...event }))).toEqual({
        success: true
      })

      const runtimeRoot = installedKevRuntimeRoot()
      expect(runtimeRoot?.startsWith(path.join(store.data, 'kev-runtime'))).toBe(true)
      expect(fs.readFileSync(path.join(runtimeRoot!, 'verified.sha256'), 'utf8').trim()).toBe(
        store.sha256
      )
      expect(resolveKevRuntimeArtifact(KEV_4B_ID)?.python).toBe(
        path.join(runtimeRoot!, 'kev-runtime', 'python', 'bin', 'python3')
      )
      const transfer = progress.filter((event) => event.currentFile === 'Kev runtime')
      expect(transfer.at(-1)).toMatchObject({
        fileIndex: 1,
        fileCount: 1,
        downloadedBytes: store.archive.length,
        totalBytes: store.archive.length
      })
      expect(progress.at(-1)).toMatchObject({ status: 'completed', percent: 100 })
      expect(await listInstalled()).toContain(KEV_4B_ID)
      expect(fs.readdirSync(path.join(store.data, 'kev-runtime'))).toEqual([
        path.basename(runtimeRoot!)
      ])
    })

    it('resumes a partial runtime archive with a Range request', async () => {
      const partial = path.join(
        store.data,
        'kev-runtime',
        `test-v1-${store.sha256.slice(0, 12)}.tar.gz.part`
      )
      fs.mkdirSync(path.dirname(partial), { recursive: true })
      fs.writeFileSync(partial, store.archive.subarray(0, 100))

      expect((await downloadModel(KEV_4B_ID)).success).toBe(true)

      expect(store.requests).toEqual([{ range: 'bytes=100-' }])
      expect(installedKevRuntimeRoot()).not.toBeNull()
      expect(fs.existsSync(partial)).toBe(false)
    })

    it('rejects an archive that does not match the pinned SHA-256 and installs nothing', async () => {
      const corrupt = Buffer.from(store.archive)
      corrupt.writeUInt8(corrupt.readUInt8(corrupt.length - 1) ^ 0xff, corrupt.length - 1)
      store.serve(corrupt)
      const progress: DownloadProgress[] = []

      const result = await downloadModel(KEV_4B_ID, (event) => progress.push({ ...event }))

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/SHA-256/)
      expect(progress.at(-1)?.status).toBe('failed')
      expect(installedKevRuntimeRoot()).toBeNull()
      expect(resolveKevRuntimeArtifact(KEV_4B_ID)).toBeNull()
      expect(fs.readdirSync(path.join(store.data, 'kev-runtime'))).toEqual([])
    })
  }
)
