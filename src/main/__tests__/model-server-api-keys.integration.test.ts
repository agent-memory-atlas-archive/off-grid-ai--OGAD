/**
 * Gateway API key enforcement over real HTTP and the real secret store. The OS keychain
 * (Electron safeStorage) is the only fake: it encrypts by passing bytes through and, while
 * locked, refuses to decrypt by throwing, as safeStorage does when the keychain is unavailable.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-keys-'))
const previousDataDir = process.env.OFFGRID_DATA_DIR

const keychain = vi.hoisted(() => ({ locked: false }))

vi.mock('electron', () => ({
  app: {
    getPath: () => PROFILE_DIR,
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => 'test'
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => {
      if (keychain.locked) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
      return value.toString()
    }
  }
}))

let gatewayPort = 0
let server: typeof import('../model-server')

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function poll(key?: string): Promise<Response> {
  const deadline = Date.now() + 2_000
  for (;;) {
    try {
      return await fetch(`http://127.0.0.1:${gatewayPort}/v1/requests/missing`, {
        headers: key ? { Authorization: `Bearer ${key}` } : undefined
      })
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

async function pollStatus(key?: string): Promise<number> {
  return (await poll(key)).status
}

async function whileLocked<T>(work: () => Promise<T>): Promise<T> {
  keychain.locked = true
  try {
    return await work()
  } finally {
    keychain.locked = false
  }
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = PROFILE_DIR
  server = await import('../model-server')
  gatewayPort = await unusedPort()
  server.startModelServer(gatewayPort)
})

afterAll(() => {
  server.stopModelServer()
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
})

describe('gateway API key enforcement', () => {
  it('turns authentication on when the first key is created', async () => {
    const created = server.createGatewayApiKey('Laptop', null)

    expect(created.settings.enabled).toBe(true)
    expect(await pollStatus()).toBe(401)
    expect(await pollStatus(created.key)).toBe(404)
  })

  it('keeps a locked keychain closed while keys are required and says why', async () => {
    const response = await whileLocked(() => poll())

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { message: 'API key storage is locked.' } })
    await whileLocked(async () =>
      expect(() => server.gatewayApiKeySettings()).toThrow('API key storage is locked')
    )
  })

  it('keeps serving through a locked keychain once keys are no longer required', async () => {
    server.setGatewayApiKeyRequired(false)

    expect(await whileLocked(() => pollStatus())).toBe(404)
  })

  it('treats a key store from a build that never recorded the setting as required until it is read', async () => {
    const { deleteSetting } = await import('../database')
    deleteSetting('gatewayApiKeysRequired')

    expect(await whileLocked(() => pollStatus())).toBe(503)
    expect(await pollStatus()).toBe(404)
    expect(await whileLocked(() => pollStatus())).toBe(404)
  })
})
