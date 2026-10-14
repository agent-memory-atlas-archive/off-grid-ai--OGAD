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
import { getDB } from '../database'
import { synthesize } from '../tts'

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
})
