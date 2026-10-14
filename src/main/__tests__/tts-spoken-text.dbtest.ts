import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-spoken-text-'))
const previousDirectory = process.env.OFFGRID_DATA_DIR
process.env.OFFGRID_DATA_DIR = directory
vi.mock('electron', () => ({
  app: { getPath: () => directory, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
import { createServer } from 'node:http'
import { getDB } from '../database'
import { synthesize } from '../tts'
import {
  activateRemoteVisionMediaModel,
  setRemoteVisionServerSettings
} from '../vision/remote-vision-server'

afterAll(() => {
  getDB().close()
  if (previousDirectory === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDirectory
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('speech synthesis input', () => {
  it('refuses text with nothing to say aloud before choosing a voice', async () => {
    await expect(synthesize('🎉🙂')).rejects.toThrow('Nothing to speak.')
    await expect(synthesize('   ')).rejects.toThrow('Nothing to speak.')
  })

  it('sends a remote voice the same words a local voice would speak', async () => {
    const inputs: string[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        inputs.push(JSON.parse(body).input)
        res.setHeader('content-type', 'audio/wav')
        res.end('fixture-audio')
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture port')
      const settings = setRemoteVisionServerSettings({
        provider: 'ogad',
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: '',
        mediaModels: { voice: 'fixture-tts' }
      })
      const serverId = settings.servers[0]!.id
      expect(activateRemoteVisionMediaModel(serverId, 'voice', 'fixture-tts')).toBe(true)

      await synthesize('Ship it 🚀', 'af_heart')
      expect(inputs).toEqual(['Ship it'])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
