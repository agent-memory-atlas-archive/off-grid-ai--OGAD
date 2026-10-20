import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { KEV_4B_ID, listInstalled } from '../models-manager'
import { installedKevRuntimeRoot } from '../kev-runtime-pack'
import { decisionRuntime } from '../accessibility/decision-runtime'
import {
  reportAppleSiliconHost,
  startKevRuntimeStore,
  type KevRuntimeStore
} from './kev-runtime-store-fixture'

// A Kev install from a release that bundled the runtime: after the update the model is on
// disk and the runtime is gone. Kev's first start fetches it, then runs that Python.
let store: KevRuntimeStore
let restoreHost: () => void

beforeAll(async () => {
  restoreHost = reportAppleSiliconHost()
  store = await startKevRuntimeStore(
    fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kev-first-start-'))
  )
})
beforeEach(() => store.reset())
afterEach(() => decisionRuntime.shutdown())
afterAll(async () => {
  await store.close()
  restoreHost()
})

// The fixture runtime's python3 is a POSIX script, so it starts on macOS and Linux.
describe.skipIf(process.platform === 'win32')('Kev first start without its runtime', () => {
  it('downloads the runtime, then starts Kev from it', async () => {
    expect(await listInstalled()).toContain(KEV_4B_ID)
    expect(installedKevRuntimeRoot()).toBeNull()

    await decisionRuntime.start(KEV_4B_ID)

    const runtimeRoot = installedKevRuntimeRoot()
    expect(runtimeRoot).not.toBeNull()
    expect(decisionRuntime.running).toBe(true)
    expect(fs.readFileSync(store.recordFile, 'utf8')).toBe(
      path.join(runtimeRoot!, 'kev-runtime', 'python', 'bin', 'python3')
    )
    expect(store.requests).toHaveLength(1)
  })

  it('says the runtime download failed instead of starting Kev', async () => {
    store.writeManifest('0'.repeat(64))

    await expect(decisionRuntime.start(KEV_4B_ID)).rejects.toThrow(
      /Kev's runtime could not be downloaded: .*SHA-256/
    )
    expect(decisionRuntime.running).toBe(false)
    expect(fs.existsSync(store.recordFile)).toBe(false)
  })
})
