// Each modality runs on the server it was picked on. Choosing an image model on a second server
// leaves chat where it was; turning that server off moves only what ran on it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-remote-modalities-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => TMP_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

const previousDataDir = process.env.OFFGRID_DATA_DIR
beforeAll(() => {
  process.env.OFFGRID_DATA_DIR = TMP_DIR
})
afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
})

describe('models picked on different servers', () => {
  it('keep chat on its server when an image model is picked on another', async () => {
    const remote = await import('../remote-vision-server')
    remote.setRemoteVisionServerSettings({
      serverId: 'pod',
      name: 'RTX Pro 6000',
      provider: 'custom',
      endpoint: 'http://127.0.0.1:17878/v1',
      model: 'flint',
      mediaModels: { text: 'flint' }
    })
    remote.setRemoteVisionServerSettings({
      serverId: 'cloud',
      name: 'OpenRouter',
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      model: '',
      mediaModels: { image: 'flux' }
    })
    // Adding a server for images leaves chat where it was.
    expect(remote.getActiveRemoteVisionServer()?.id).toBe('pod')
    expect(remote.activateRemoteVisionModel('pod', 'flint')).toBe(true)
    expect(remote.activateRemoteVisionMediaModel('cloud', 'image', 'flux')).toBe(true)

    expect(remote.getActiveRemoteVisionServer()?.id).toBe('pod')
    expect(remote.getActiveRemoteVisionServerForModality('image')?.id).toBe('cloud')
    expect(remote.getRemoteVisionServerSettings().activeServerId).toBe('pod')

    // Saving the other server again (an edit) does not carry chat over to it.
    remote.setRemoteVisionServerSettings({
      serverId: 'cloud',
      name: 'OpenRouter',
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      model: '',
      mediaModels: { image: 'flux' }
    })
    expect(remote.getActiveRemoteVisionServer()?.id).toBe('pod')

    // Turning the image server off moves only image: it has no other server, so it runs locally.
    remote.setRemoteVisionServerSettings({
      serverId: 'cloud',
      name: 'OpenRouter',
      provider: 'openrouter',
      endpoint: 'https://openrouter.ai/api/v1',
      model: '',
      mediaModels: { image: 'flux' },
      enabled: false
    })
    expect(remote.getActiveRemoteVisionServer()?.id).toBe('pod')
    // Image had no other server with an image model: it runs locally, not on the chat server.
    expect(remote.remoteServerIdFor('image')).toBeNull()
  })
})
