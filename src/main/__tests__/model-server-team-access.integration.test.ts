/**
 * Who may call the gateway's model routes, over real HTTP on every interface. With API keys not
 * required, single mode stays open to the network as it always has; team mode admits this machine,
 * and a caller on the network only with an API key or a paired device's own credential.
 *
 * The network caller is this host reached through its own LAN address, so the gateway sees a
 * non-loopback peer. Nothing of ours is faked; Electron's app and keychain are the only stand-ins.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { primaryLanAddress } from '../lan-address'

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gateway-team-access-'))

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

const lanIp = primaryLanAddress()
const previousDataDir = process.env.OFFGRID_DATA_DIR
let gatewayPort: number
let llm: typeof import('../llm').llm
let gateway: typeof import('../model-server')
const PAIRED_TOKEN = 'paired-device-token-0123456789abcdef'

async function unusedPort(): Promise<number> {
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '0.0.0.0', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

/** A model route behind the key check; an unknown request id answers 404 once admitted. */
async function call(host: string, bearer?: string): Promise<number> {
  const response = await fetch(`http://${host}:${gatewayPort}/v1/requests/not-a-request`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {}
  })
  await response.text()
  return response.status
}

beforeAll(async () => {
  process.env.OFFGRID_DATA_DIR = TMP_DIR
  ;({ llm } = await import('../llm'))
  gateway = await import('../model-server')
  const { registerActiveActionCredentials } = await import('../mcp-auth')
  registerActiveActionCredentials(() => [{ deviceId: 'phone-1', token: PAIRED_TOKEN }])
  gatewayPort = await unusedPort()
  await gateway.startModelServer(gatewayPort)
})

afterAll(async () => {
  const { registerActiveActionCredentials } = await import('../mcp-auth')
  registerActiveActionCredentials(null)
  await llm.setSettings({ gatewayMode: 'single' })
  gateway.stopModelServer()
  fs.rmSync(TMP_DIR, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
  else process.env.OFFGRID_DATA_DIR = previousDataDir
})

describe.skipIf(!lanIp)('API keys not required', () => {
  it('single mode serves this machine and the network without a key, as before', async () => {
    await llm.setSettings({ gatewayMode: 'single' })
    expect(gateway.gatewayApiKeySettings().enabled).toBe(false)
    expect(await call('127.0.0.1')).toBe(404)
    expect(await call(lanIp!)).toBe(404)
  })

  it('team mode refuses a network caller without a credential', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    expect(await call(lanIp!)).toBe(401)
    expect(await call(lanIp!, 'not-a-key')).toBe(401)
  })

  it('team mode keeps serving this machine without a key', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    expect(await call('127.0.0.1')).toBe(404)
  })

  it('team mode admits a paired device by its own credential', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    expect(await call(lanIp!, PAIRED_TOKEN)).toBe(404)
  })

  it('team mode admits a network caller with an API key, though keys are not required', async () => {
    await llm.setSettings({ gatewayMode: 'team' })
    const { key } = gateway.createGatewayApiKey('laptop', null)
    // Creating a key turns the requirement on; the person turns it off again for this machine.
    expect(gateway.setGatewayApiKeyRequired(false).enabled).toBe(false)
    expect(await call(lanIp!, key)).toBe(404)
    expect(await call(lanIp!)).toBe(401)
    expect(await call('127.0.0.1')).toBe(404)
  })
})
