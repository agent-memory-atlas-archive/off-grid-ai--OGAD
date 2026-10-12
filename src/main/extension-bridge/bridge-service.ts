import type { BridgeMediaData } from './bridge-media-handlers'
import { rpcHandlers } from './bridge-rpc-handlers'
import {
  type ConversationListParams,
  type ConversationSearchParams,
  type ConversationSearchResult,
  type ConversationPage
} from './bridge-conversations'
import { type ChatRequest } from './bridge-chat'
// The extension bridge, as pure logic: pairing and the sealed RPC loop. Everything it touches
// (key storage, the native confirm dialog, the chat database, tools, the vault) is injected,
// so this file is unit-tested without Electron. bridge-electron.ts supplies the real ones.
//
// Paired browsers are NOT sync devices. They live in their own store and never count toward
// the Pro device limit; a browser is a client of this desktop, not a peer in the mesh.

import {
  deriveSessionKey,
  exportPublicKey,
  importPublicKey,
  open,
  pairingCode,
  parseEnvelope,
  parsePairRequest,
  parseRpcRequest,
  ReplayGuard,
  requestAad,
  responseAad,
  seal,
  BRIDGE_VERSION,
  type BridgeFeatures
} from './bridge-protocol'
import type { SettingsSection } from './bridge-settings'

export interface PairedBrowser {
  readonly id: string
  readonly name: string
  readonly publicKey: string
  readonly pairedAt: number
}

/** Browsers kept at most. Separate from, and never counted against, the sync device limit. */
export const MAX_BROWSERS = 10

export interface BridgeStore {
  list(): Promise<readonly PairedBrowser[]>
  save(browsers: readonly PairedBrowser[]): Promise<void>
}

export type { BridgeFeatures } from './bridge-protocol'

/** What a paired browser sees of a web task it started (desktop task-progress.ts). */
export interface BrowserTaskProgress {
  readonly taskId: string
  readonly status: string
  readonly summary: string
  /** Phase titles in order; empty before the plan is made. */
  readonly plan: readonly string[]
  /** Index into `plan` of the phase in progress, or -1 with no plan. */
  readonly phase: number
  readonly steps: readonly string[]
  readonly action: string
}

export interface BridgeData extends Partial<BridgeMediaData> {
  chat?(request: ChatRequest, browser: PairedBrowser): Promise<unknown>
  features(): BridgeFeatures
  desktopName(): string
  listConversations(): Promise<unknown[]>
  listConversationPage?(params: ConversationListParams): Promise<ConversationPage<unknown>>
  searchConversations?(params: ConversationSearchParams): Promise<ConversationSearchResult>
  putConversation(conversation: unknown, browser: PairedBrowser): Promise<void>
  deleteConversation(id: string): Promise<void>
  listTools(task?: string): Promise<unknown[]>
  /** `tabId`: the browser's tab a web task should start in (browser-start-tab.ts). */
  runTool(
    name: string,
    args: Record<string, unknown>,
    browser: PairedBrowser,
    tabId?: number
  ): Promise<unknown>
  /** Task progress scoped to the browser and optional task id. */
  latestTask(
    browser: PairedBrowser,
    since: number,
    taskId?: string
  ): Promise<BrowserTaskProgress | null>
  /** Stops a task this browser started (its journey is this browser's). False otherwise. */
  stopTask(browser: PairedBrowser, taskId: string): Promise<boolean>
  setTaskRole(request: {
    task: unknown
    role: unknown
    modelId: unknown
  }): Promise<{ success: boolean; error?: string }>
  vault(request: unknown, browser: PairedBrowser): Promise<unknown>
  /** One section of the desktop's settings (settings.ts), as its Settings screen shows it. */
  readSettings(section: SettingsSection): Promise<unknown>
  /** Apply an already-validated patch through the desktop's own setters. */
  writeSettings(section: SettingsSection, patch: Record<string, unknown>): Promise<void>
}

export interface BridgeDeps {
  readonly keys: CryptoKeyPair
  readonly store: BridgeStore
  /** Show the code and the browser's name in the desktop's own window. True = approved. */
  confirmPairing(code: string, deviceName: string): Promise<boolean>
  readonly data: BridgeData
  now(): number
  newId(): string
}

export type BridgeReply = { status: number; body: unknown }

const UNAUTHORIZED: BridgeReply = { status: 401, body: { error: 'unauthorized' } }

export interface BridgeService {
  info(): Promise<BridgeReply>
  pair(raw: unknown): Promise<BridgeReply>
  rpc(raw: unknown): Promise<BridgeReply>
  /** A paired browser and its session key, for the live socket. Null for an unknown device. */
  linkKey(deviceId: string): Promise<{ browser: PairedBrowser; key: CryptoKey } | null>
  /** True the first time a socket hello nonce is seen inside the freshness window. */
  acceptNonce(deviceId: string, nonce: string): boolean
}

export function createBridgeService(deps: BridgeDeps): BridgeService {
  const replay = new ReplayGuard()
  const sessionKeys = new Map<string, Promise<CryptoKey>>()
  let pairing = false

  const sessionKey = (browser: PairedBrowser): Promise<CryptoKey> => {
    const cached = sessionKeys.get(browser.id)
    if (cached) {
      return cached
    }
    const derived = (async () => {
      const peer = await importPublicKey(browser.publicKey)
      if (!peer) {
        throw new Error('stored key invalid')
      }
      return deriveSessionKey(deps.keys.privateKey, peer, browser.id)
    })()
    sessionKeys.set(browser.id, derived)
    return derived
  }

  const handlers = rpcHandlers(deps, (id) => void sessionKeys.delete(id))

  return {
    /** Unauthenticated: the desktop's public key and protocol version. Nothing private. */
    async info(): Promise<BridgeReply> {
      return {
        status: 200,
        body: { v: BRIDGE_VERSION, publicKey: await exportPublicKey(deps.keys.publicKey) }
      }
    },

    async pair(raw: unknown): Promise<BridgeReply> {
      const request = parsePairRequest(raw)
      if (!request || !(await importPublicKey(request.publicKey))) {
        return { status: 400, body: { error: 'invalid' } }
      }
      // One prompt at a time: a page or process cannot stack dialogs on the user.
      if (pairing) {
        return { status: 409, body: { error: 'busy' } }
      }
      pairing = true
      try {
        const code = await pairingCode(
          request.publicKey,
          await exportPublicKey(deps.keys.publicKey)
        )
        if (!(await deps.confirmPairing(code, request.deviceName))) {
          return { status: 403, body: { error: 'declined' } }
        }
        const existing = (await deps.store.list()).filter((b) => b.publicKey !== request.publicKey)
        const browser: PairedBrowser = {
          id: deps.newId(),
          name: request.deviceName,
          publicKey: request.publicKey,
          pairedAt: deps.now()
        }
        await deps.store.save([browser, ...existing].slice(0, MAX_BROWSERS))
        return { status: 200, body: { deviceId: browser.id } }
      } finally {
        pairing = false
      }
    },

    async rpc(raw: unknown): Promise<BridgeReply> {
      const envelope = parseEnvelope(raw)
      if (!envelope) {
        return UNAUTHORIZED
      }
      const browser = (await deps.store.list()).find((b) => b.id === envelope.d)
      if (!browser) {
        return UNAUTHORIZED
      }
      const key = await sessionKey(browser)
      const request = parseRpcRequest(await open(key, requestAad(browser.id), envelope), deps.now())
      // Wrong key, tampered, stale or replayed all look the same from outside.
      if (!request || !replay.accept(`${browser.id}:${request.id}`, deps.now())) {
        return UNAUTHORIZED
      }
      let reply: unknown
      try {
        // Pairing, access status and cleanup remain available without Pro.
        if (
          !['state', 'unpair', 'tasks.stop', 'chat.stop'].includes(request.method) &&
          !deps.data.features().pro
        ) {
          throw new Error('pro_required')
        }
        const result = await handlers[request.method](request.params, browser)
        reply = { id: request.id, ok: true, result }
      } catch (error) {
        // Error text only: no stack, no argument echo.
        reply = {
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : 'failed'
        }
      }
      return { status: 200, body: await seal(key, responseAad(browser.id, request.id), reply) }
    },

    async linkKey(deviceId: string) {
      const browser = (await deps.store.list()).find((b) => b.id === deviceId)
      return browser && deps.data.features().pro
        ? { browser, key: await sessionKey(browser) }
        : null
    },

    acceptNonce(deviceId: string, nonce: string): boolean {
      return replay.accept(`${deviceId}:hello:${nonce}`, deps.now())
    }
  }
}
