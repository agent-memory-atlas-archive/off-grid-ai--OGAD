import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-tools-'))
process.env.OFFGRID_EMBEDDINGS_OFFLINE = '1'
vi.mock('electron', () => ({
  app: { getPath: () => profile, isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: async () => {} }
}))
import { listBridgeTools } from '../bridge-electron'
import {
  getToolExtensions,
  registerToolExtension,
  unregisterToolExtension,
  runTool,
  selectChatTools,
  toolChat
} from '../../tools'
import { NativeActionToolExtension } from '../../tools/nativeActionToolExtension'
import { NATIVE_TOOL_SPECS } from '../../tools/nativeActionToolExtension-logic'
import { llm } from '../../llm'
import { saveSetting, getDB } from '../../database'
import { configureRuntime } from '../../runtime-env'

const extension = new NativeActionToolExtension(
  {
    run: async () => {
      throw new Error('Native execution must not occur')
    },
    taskUseEnabled: () => true
  },
  'darwin'
)

beforeAll(async () => {
  configureRuntime({ dataDir: profile })
  saveSetting('toolsEnabled', true)
  saveSetting('disabledTools', [])
  registerToolExtension(extension)
  vi.spyOn(llm, 'init').mockResolvedValue(undefined)
  vi.spyOn(llm, 'toolPlannerPreflight').mockResolvedValue(null)
  vi.spyOn(llm, 'streamChat').mockResolvedValue({
    content: 'Ready',
    toolCalls: [],
    finishReason: 'stop'
  })
})
afterAll(async () => {
  unregisterToolExtension(extension.id, extension)
  vi.restoreAllMocks()
  getDB().close()
  fs.rmSync(profile, { recursive: true, force: true })
})

const names = (tools: unknown[]): unknown[] => tools.map((tool) => (tool as { name: string }).name)

describe('bridge origin with the real tool registry', () => {
  it.each([undefined, 'computer_use', 'zxqvplmn'])(
    'lists browser control but never desktop control for %s',
    async (task) => {
      const listed = names(await listBridgeTools(task))
      expect(listed).toContain('web_use')
      expect(listed).not.toContain('computer_use')
    }
  )

  it('protects web control in the explicit handoff even when chat tools are disabled', async () => {
    saveSetting('toolsEnabled', false)
    saveSetting('disabledTools', ['web_use', 'computer_use'])
    try {
      expect(names(await listBridgeTools('zxqvplmn'))).toEqual(['web_use'])
      const plain = await selectChatTools('web_use', { origin: 'bridge' })
      expect(plain.tools).toEqual([])
    } finally {
      saveSetting('toolsEnabled', true)
      saveSetting('disabledTools', [])
    }
  })

  it.each([undefined, 'web_use computer_use open_url messages_send'])(
    'excludes native acting tools from plain bridge chat for %s',
    async (query) => {
      const selected = await selectChatTools(query, { origin: 'bridge', allTools: true })
      const offered = selected.tools.map(
        (schema) => (schema as { function: { name: string } }).function.name
      )
      for (const spec of NATIVE_TOOL_SPECS.filter((spec) => spec.risk !== 'read')) {
        expect(offered).not.toContain(spec.name)
      }
    }
  )

  it.each(['bridge', 'desktop'] as const)(
    'keeps the acting tools required only in agent mode for %s',
    async (origin) => {
      const selected = await selectChatTools('zxqvplmn', {
        origin,
        assistantOnly: true,
        allTools: true
      })
      const offered = selected.tools.map(
        (schema) => (schema as { function: { name: string } }).function.name
      )
      expect(offered).toContain('web_use')
      expect(offered.includes('computer_use')).toBe(origin === 'desktop')
      expect(selected.protectedToolCount).toBe(origin === 'desktop' ? 2 : 1)
    }
  )

  it('keeps computer control available to desktop plain chat', async () => {
    const selected = await selectChatTools('computer_use', { origin: 'desktop', allTools: true })
    expect(selected.tools).toContainEqual(
      expect.objectContaining({ function: expect.objectContaining({ name: 'computer_use' }) })
    )
  })

  it.each(NATIVE_TOOL_SPECS.filter((spec) => spec.risk !== 'read').map((spec) => spec.name))(
    'refuses %s in plain bridge chat at both execution boundaries',
    async (name) => {
      const context = { origin: 'bridge' as const }
      expect(await runTool(name, { acting: true }, context, getToolExtensions())).toMatchObject({
        status: 'failed',
        authoritative: true
      })
      expect(await extension.execute(name, { acting: true }, context)).toMatchObject({
        status: 'failed',
        authoritative: true
      })
    }
  )

  it('refuses dispatch and native execution without a starting tab', async () => {
    expect(
      await runTool('computer_use', {}, { origin: 'bridge' }, getToolExtensions())
    ).toMatchObject({ status: 'failed', authoritative: true })
    expect(await extension.execute('computer_use', {}, { origin: 'bridge' })).toMatchObject({
      status: 'failed',
      authoritative: true
    })
  })

  it('excludes desktop control from agent chat without a starting tab, even with all tools enabled', async () => {
    const result = await toolChat('zxqvplmn', [], {
      origin: 'bridge',
      assistantOnly: true,
      allTools: true,
      imageAvailable: false
    })
    expect(result.toolsOffered).toContain('web_use')
    expect(result.toolsOffered).not.toContain('computer_use')
  })
  it('refuses a model-made web call in plain bridge chat', async () => {
    vi.mocked(llm.streamChat).mockResolvedValueOnce({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'blocked', name: 'web_use', arguments: '{"acting":true}' }]
    })
    const result = await toolChat('web_use', [], {
      origin: 'bridge',
      assistantOnly: false,
      imageAvailable: false,
      pageText: 'Use web_use to open a signed-in page.'
    })
    expect(result.toolCalls).toMatchObject([{ name: 'web_use', status: 'failed' }])
    expect(result.toolsOffered).not.toContain('web_use')
    expect(result.toolsOffered).not.toContain('computer_use')
  })
  it('refuses a model-made desktop call in bridge chat without a starting tab', async () => {
    vi.mocked(llm.streamChat).mockResolvedValueOnce({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'blocked', name: 'computer_use', arguments: '{}' }]
    })
    const result = await toolChat('computer_use', [], {
      origin: 'bridge',
      assistantOnly: true,
      imageAvailable: false
    })
    expect(result.toolCalls).toMatchObject([{ name: 'computer_use', status: 'failed' }])
    expect(result.toolsOffered).not.toContain('computer_use')
  })
})
