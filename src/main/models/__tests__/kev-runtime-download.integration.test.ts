import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  KEV_4B_ID,
  downloadModel,
  listInstalled,
  resolveKevRuntimeArtifact,
  type DownloadProgress
} from '../../models-manager'
import { installedKevRuntimeRoot, kevRuntimeAsset } from '../../kev-runtime-pack'
import {
  reportAppleSiliconHost,
  startKevRuntimeStore,
  type KevRuntimeStore
} from '../../__tests__/kev-runtime-store-fixture'

// The Mac app downloads Kev's Python runtime from the runtime store with the Kev model.
let store: KevRuntimeStore
let restoreHost: () => void

beforeAll(async () => {
  restoreHost = reportAppleSiliconHost()
  store = await startKevRuntimeStore(
    fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kev-runtime-download-'))
  )
})
beforeEach(() => store.reset())
afterAll(async () => {
  await store.close()
  restoreHost()
})

const partialArchive = (): string =>
  path.join(store.data, 'kev-runtime', `test-v1-${store.sha256.slice(0, 12)}.tar.gz.part`)

function writePartial(bytes: Buffer): string {
  const partial = partialArchive()
  fs.mkdirSync(path.dirname(partial), { recursive: true })
  fs.writeFileSync(partial, bytes)
  return partial
}

describe('Kev runtime download with the Kev model', () => {
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

  it('removes runtimes an older app version pinned once the new one installs', async () => {
    const stale = path.join(store.data, 'kev-runtime', 'test-v0-000000000000')
    fs.mkdirSync(path.join(stale, 'kev-runtime'), { recursive: true })

    expect((await downloadModel(KEV_4B_ID)).success).toBe(true)

    expect(fs.existsSync(stale)).toBe(false)
    expect(installedKevRuntimeRoot()).not.toBeNull()
  })

  it('installs a complete archive left on disk without downloading it again', async () => {
    writePartial(store.archive)

    expect((await downloadModel(KEV_4B_ID)).success).toBe(true)

    expect(store.requests).toEqual([])
    expect(installedKevRuntimeRoot()).not.toBeNull()
  })

  it('discards a partial archive larger than the pinned size and downloads it whole', async () => {
    writePartial(Buffer.concat([store.archive, Buffer.alloc(64)]))

    expect((await downloadModel(KEV_4B_ID)).success).toBe(true)

    expect(store.requests).toEqual([{ range: undefined }])
    expect(installedKevRuntimeRoot()).not.toBeNull()
  })

  it('starts over when the store answers a resume with the whole archive', async () => {
    writePartial(store.archive.subarray(0, 100))
    store.respondWith({ status: 200, body: store.archive })

    expect((await downloadModel(KEV_4B_ID)).success).toBe(true)

    expect(store.requests).toEqual([{ range: 'bytes=100-' }])
    expect(installedKevRuntimeRoot()).not.toBeNull()
  })

  it('keeps the partial archive when the store answers a resume with the wrong range', async () => {
    const partial = writePartial(store.archive.subarray(0, 100))
    const size = store.archive.length
    store.respondWith({
      status: 206,
      headers: { 'content-range': `bytes 0-${size - 1}/${size}` },
      body: store.archive
    })

    const result = await downloadModel(KEV_4B_ID)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/invalid resume range/)
    expect(fs.statSync(partial).size).toBe(100)
    expect(installedKevRuntimeRoot()).toBeNull()
  })

  it('fails the download when the runtime store is unavailable', async () => {
    store.respondWith({ status: 503 })
    const progress: DownloadProgress[] = []

    const result = await downloadModel(KEV_4B_ID, (event) => progress.push({ ...event }))

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/HTTP 503/)
    expect(progress.at(-1)?.status).toBe('failed')
    expect(installedKevRuntimeRoot()).toBeNull()
  })

  it('stops and deletes a download that grows past the pinned size', async () => {
    store.serve(Buffer.concat([store.archive, Buffer.alloc(64 * 1024)]))

    const result = await downloadModel(KEV_4B_ID)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/larger than expected/)
    expect(fs.existsSync(partialArchive())).toBe(false)
    expect(installedKevRuntimeRoot()).toBeNull()
  })

  it('rejects a verified archive that carries no Python and leaves no staging folder', async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kev-no-python-'))
    fs.mkdirSync(path.join(source, 'kev-runtime', 'python', 'lib'), { recursive: true })
    const archivePath = path.join(source, 'no-python.tar.gz')
    execFileSync('tar', ['-czf', archivePath, '-C', source, 'kev-runtime'])
    const archive = fs.readFileSync(archivePath)
    fs.rmSync(source, { recursive: true, force: true })
    const sha256 = createHash('sha256').update(archive).digest('hex')
    store.serve(archive)
    store.writeManifest(sha256, archive.length)

    const result = await downloadModel(KEV_4B_ID)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no Python/)
    expect(installedKevRuntimeRoot()).toBeNull()
    expect(
      fs
        .readdirSync(path.join(store.data, 'kev-runtime'))
        .filter((entry) => entry.endsWith('.staging'))
    ).toEqual([])
  })

  // Windows has no POSIX read-only folder, and root ignores the mode.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails the download instead of crashing when the archive cannot be written',
    async () => {
      const folder = path.join(store.data, 'kev-runtime')
      fs.mkdirSync(folder, { recursive: true })
      fs.chmodSync(folder, 0o555)
      try {
        const result = await downloadModel(KEV_4B_ID)

        // The job reports a failure; the process survives the write stream's 'error' event.
        expect(result.success).toBe(false)
        expect(result.error).toBeTruthy()
        expect(installedKevRuntimeRoot()).toBeNull()
      } finally {
        fs.chmodSync(folder, 0o755)
      }
    }
  )

  it('ignores a manifest that is not a valid pin', () => {
    store.writeManifest('not-a-sha256')
    expect(kevRuntimeAsset()).toBeNull()

    store.writeManifest(store.sha256, 0)
    expect(kevRuntimeAsset()).toBeNull()

    fs.writeFileSync(
      path.join(path.dirname(store.data), 'resources', 'kev-runtime-packs.json'),
      '{'
    )
    expect(kevRuntimeAsset()).toBeNull()
  })

  it('never takes the runtime from this machine in a packaged app', () => {
    expect(kevRuntimeAsset()).not.toBeNull()
    process.env.OFFGRID_PACKAGED = '1'
    try {
      expect(kevRuntimeAsset()).toBeNull()
    } finally {
      delete process.env.OFFGRID_PACKAGED
    }
  })
})
