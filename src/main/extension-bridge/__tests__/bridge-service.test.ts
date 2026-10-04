import { describe, expect, it } from 'vitest'
import {
  deriveSessionKey,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
  open,
  pairingCode,
  requestAad,
  responseAad,
  seal
} from '../bridge-protocol'
import {
  createBridgeService,
  MAX_BROWSERS,
  type BridgeData,
  type BridgeFeatures,
  type BridgeReply,
  type BridgeService,
  type PairedBrowser
} from '../bridge-service'

const FREE: BridgeFeatures = {
  pro: false,
  chats: true,
  tools: false,
  connectors: true,
  vault: false
}
const PRO: BridgeFeatures = { pro: true, chats: true, tools: true, connectors: true, vault: true }

interface CallResult {
  status: number
  body: unknown
  raw?: unknown
}

interface Setup {
  bridge: BridgeService
  pair(): Promise<BridgeReply>
  call(
    deviceId: string,
    method: string,
    params?: Record<string, unknown>,
    id?: string
  ): Promise<CallResult>
  prompts: string[]
  calls: string[]
  saved(): PairedBrowser[]
  setNow(t: number): number
  desk: CryptoKeyPair
  browserPub: string
  sealedFor: { browser: CryptoKeyPair }
}

async function setup(opts: { approve?: boolean; features?: BridgeFeatures } = {}): Promise<Setup> {
  const desk = await generateKeyPair()
  let saved: PairedBrowser[] = []
  let now = 1_000_000
  let ids = 0
  const prompts: string[] = []
  const calls: string[] = []
  const data: BridgeData = {
    features: () => opts.features ?? FREE,
    desktopName: () => 'Off Grid AI Desktop',
    listConversations: async () => [{ id: 'c1' }],
    putConversation: async () => {
      calls.push('put')
    },
    deleteConversation: async (id) => {
      calls.push(`delete:${id}`)
    },
    listTools: async () => [{ name: 'notion_search' }],
    runTool: async (name) => ({ ok: true, output: `ran ${name}` }),
    vault: async () => ({ type: 'status', state: 'unlocked' })
  }
  const bridge = createBridgeService({
    keys: desk,
    store: { list: async () => saved, save: async (b) => void (saved = [...b]) },
    confirmPairing: async (code, name) => {
      prompts.push(`${name}:${code}`)
      return opts.approve ?? true
    },
    data,
    now: () => now,
    newId: () => `device${String(++ids).padStart(6, '0')}`
  })
  const browser = await generateKeyPair()
  const browserPub = await exportPublicKey(browser.publicKey)

  async function pair(): Promise<BridgeReply> {
    return bridge.pair({ v: 1, publicKey: browserPub, deviceName: 'Chrome on this Mac' })
  }

  async function call(
    deviceId: string,
    method: string,
    params: Record<string, unknown> = {},
    id = `req${Math.random().toString(36).slice(2, 12)}`
  ): Promise<CallResult> {
    const deskPub = (await importPublicKey(await exportPublicKey(desk.publicKey))) as CryptoKey
    const key = await deriveSessionKey(browser.privateKey, deskPub, deviceId)
    const sealed = await seal(key, requestAad(deviceId), { id, ts: now, method, params })
    const reply = await bridge.rpc({ v: 1, d: deviceId, ...sealed })
    if (reply.status !== 200) return { status: reply.status, body: reply.body }
    return {
      status: 200,
      body: await open(key, responseAad(deviceId, id), reply.body as { n: string; c: string }),
      raw: reply.body
    }
  }

  return {
    bridge,
    pair,
    call,
    prompts,
    calls,
    saved: () => saved,
    setNow: (t: number) => (now = t),
    desk,
    browserPub,
    sealedFor: { browser }
  }
}

describe('pairing', () => {
  it('shows the user the code both sides compute, and stores the browser on approval', async () => {
    const s = await setup()
    const reply = await s.pair()
    expect(reply).toEqual({ status: 200, body: { deviceId: 'device000001' } })
    const expected = await pairingCode(s.browserPub, await exportPublicKey(s.desk.publicKey))
    expect(s.prompts).toEqual([`Chrome on this Mac:${expected}`])
    expect(s.saved().map((b) => b.name)).toEqual(['Chrome on this Mac'])
  })

  it('stores nothing when the user declines', async () => {
    const s = await setup({ approve: false })
    expect((await s.pair()).status).toBe(403)
    expect(s.saved()).toEqual([])
  })

  it('refuses a malformed request or key without prompting', async () => {
    const s = await setup()
    expect((await s.bridge.pair({ v: 1, publicKey: 'nope', deviceName: 'x' })).status).toBe(400)
    expect((await s.bridge.pair(null)).status).toBe(400)
    expect(s.prompts).toEqual([])
  })

  it('re-pairing the same browser replaces it and the list stays capped', async () => {
    const s = await setup()
    await s.pair()
    await s.pair()
    expect(s.saved()).toHaveLength(1)
    expect(MAX_BROWSERS).toBe(10)
  })

  it('serves only its public key unauthenticated', async () => {
    const s = await setup()
    const info = await s.bridge.info()
    expect(info.body).toEqual({ v: 1, publicKey: await exportPublicKey(s.desk.publicKey) })
  })
})

describe('sealed rpc', () => {
  it('answers a paired browser, sealed so only it can read the reply', async () => {
    const s = await setup()
    await s.pair()
    const r = await s.call('device000001', 'state')
    expect(r.body).toMatchObject({
      ok: true,
      result: {
        desktopName: 'Off Grid AI Desktop',
        deviceName: 'Chrome on this Mac',
        features: FREE
      }
    })
    expect(JSON.stringify(r.raw)).not.toContain('Off Grid AI Desktop')
  })

  it('refuses an unknown device, a wrong key, and garbage, all the same way', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('device999999', 'state')).status).toBe(401)
    expect(
      (await s.bridge.rpc({ v: 1, d: 'device000001', n: 'AAAAAAAAAAAAAAAA', c: 'AAAA' })).status
    ).toBe(401)
    expect((await s.bridge.rpc('nope')).status).toBe(401)
  })

  it('refuses a replayed request', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('device000001', 'state', {}, 'fixedid0001')).status).toBe(200)
    expect((await s.call('device000001', 'state', {}, 'fixedid0001')).status).toBe(401)
  })

  it('lists chats and tools, puts and deletes', async () => {
    const s = await setup()
    await s.pair()
    expect((await s.call('device000001', 'conversations.list')).body).toMatchObject({
      result: [{ id: 'c1' }]
    })
    expect((await s.call('device000001', 'tools.list')).body).toMatchObject({
      result: [{ name: 'notion_search' }]
    })
    await s.call('device000001', 'conversations.put', { conversation: {} })
    await s.call('device000001', 'conversations.delete', { id: 'c1' })
    expect(s.calls).toEqual(['put', 'delete:c1'])
    expect((await s.call('device000001', 'conversations.delete', {})).body).toMatchObject({
      ok: false,
      error: 'invalid'
    })
  })

  it('respects Free vs Pro: no vault or native tools without Pro', async () => {
    const free = await setup({ features: FREE })
    await free.pair()
    expect((await free.call('device000001', 'vault', { request: {} })).body).toMatchObject({
      ok: false,
      error: 'pro_required'
    })
    expect(
      (await free.call('device000001', 'tools.run', { name: 'mail_send', args: {} })).body
    ).toMatchObject({ ok: false, error: 'pro_required' })

    // Pro, but this desktop cannot answer for the vault or tools yet: never "upgrade".
    const stale = await setup({ features: { ...PRO, vault: false, tools: false } })
    await stale.pair()
    expect((await stale.call('device000001', 'vault', { request: {} })).body).toMatchObject({
      ok: false,
      error: 'vault_unavailable'
    })
    expect(
      (await stale.call('device000001', 'tools.run', { name: 'mail_send', args: {} })).body
    ).toMatchObject({ ok: false, error: 'tools_unavailable' })

    const pro = await setup({ features: PRO })
    await pro.pair()
    expect((await pro.call('device000001', 'vault', { request: {} })).body).toMatchObject({
      ok: true,
      result: { type: 'status' }
    })
    expect(
      (await pro.call('device000001', 'tools.run', { name: 'mail_send', args: {} })).body
    ).toMatchObject({ ok: true, result: { output: 'ran mail_send' } })
    expect((await pro.call('device000001', 'tools.run', { name: 'x' })).body).toMatchObject({
      ok: false,
      error: 'invalid'
    })
  })

  it('unpair removes the browser; its key stops working', async () => {
    const s = await setup()
    await s.pair()
    await s.call('device000001', 'unpair')
    expect(s.saved()).toEqual([])
    expect((await s.call('device000001', 'state')).status).toBe(401)
  })
})
