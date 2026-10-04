import { describe, expect, it } from 'vitest'
import { createSettingsStore, type SettingsStoreDeps } from '../bridge-settings-store'

// The desktop's own functions, faked: what a paired browser reads must be what Settings here
// shows, and what it writes must go through the same setters.

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- test fixture
function fakeDesktop() {
  const task = {
    modelStrategy: 'same_as_chat',
    context: 'auto',
    screenshotSize: 'large',
    visualHistoryFrames: 1,
    checkpointInterval: 8,
    groundingModelId: 'kept-on-desktop'
  }
  const state = {
    web: { ...task, browserTarget: 'in_app' as 'in_app' | 'default_browser' },
    computer: { ...task, showPictureInPicture: false, enabledRails: ['vision'] },
    app: { toolsEnabled: true, ttsVoice: 'af_heart', imgSeed: '7' } as Record<string, unknown>,
    tools: [
      { name: 'get_weather', description: 'Weather', enabled: true },
      { name: 'send_email', description: 'Email', enabled: false }
    ],
    connectors: [
      { id: 1, name: 'Notes', url: 'https://mcp.test/notes', enabled: 1 },
      { id: 2, name: 'Local script', url: null, enabled: 1 }
    ],
    calls: [] as string[]
  }
  const deps: SettingsStoreDeps = {
    web: () => state.web,
    setWeb: (next) => void (state.web = next as typeof state.web),
    computer: () => state.computer,
    setComputer: (next) => void (state.computer = next as typeof state.computer),
    appSettings: () => state.app,
    saveSetting: (key, value) => void (state.app = { ...state.app, [key]: value }),
    listTools: () => state.tools,
    setToolEnabled: (name, enabled) => {
      state.tools = state.tools.map((t) => (t.name === name ? { ...t, enabled } : t))
    },
    listConnectors: () => state.connectors,
    addConnector: (c) => {
      state.calls.push(`add ${c.name} ${c.transport} ${c.url}`)
    },
    setConnectorEnabled: (id, enabled) => void state.calls.push(`enable ${id} ${enabled}`),
    removeConnector: (id) => void state.calls.push(`remove ${id}`),
    activeImageModel: () => 'sdxl',
    imageParams: (_model, store) => ({
      size: 1024,
      steps: (store as Record<string, { steps?: number }> | undefined)?.sdxl?.steps ?? 28,
      cfgScale: 7
    }),
    setImageParam: (store, model, key, value) => ({
      ...(store as object),
      [model]: { ...((store as Record<string, object> | undefined)?.[model] ?? {}), [key]: value }
    }),
    transcription: async () => ({
      language: 'en',
      languages: [
        { code: 'auto', label: 'Detect' },
        { code: 'en', label: 'English' }
      ]
    })
  }
  return { state, store: createSettingsStore(deps) }
}

describe('a paired browser’s view of the desktop settings', () => {
  it('reads Tasks without anything the browser may not set', async () => {
    const { store } = fakeDesktop()
    const tasks = (await store.read('tasks')) as Record<string, Record<string, unknown>>
    expect(tasks.web).toEqual({
      modelStrategy: 'same_as_chat',
      context: 'auto',
      screenshotSize: 'large',
      visualHistoryFrames: 1,
      checkpointInterval: 8,
      browserTarget: 'in_app'
    })
    expect(tasks.computer).toMatchObject({ showPictureInPicture: false, enabledRails: ['vision'] })
    expect(JSON.stringify(tasks)).not.toContain('groundingModelId')
  })

  it('writes Tasks through the setters, keeping what the browser did not send', async () => {
    const { store, state } = fakeDesktop()
    await store.write('tasks', { web: { browserTarget: 'default_browser' } })
    expect(state.web).toMatchObject({
      browserTarget: 'default_browser',
      groundingModelId: 'kept-on-desktop'
    })
    await store.write('tasks', { computer: { enabledRails: ['ax'], showPictureInPicture: true } })
    expect(state.computer).toMatchObject({ enabledRails: ['ax'], showPictureInPicture: true })
  })

  it('switches tools, and ignores a tool the desktop does not have', async () => {
    const { store, state } = fakeDesktop()
    await store.write('tools', { enabled: false, tool: { name: 'send_email', enabled: true } })
    await store.write('tools', { tool: { name: 'made_up', enabled: false } })
    expect(state.app.toolsEnabled).toBe(false)
    expect(await store.read('tools')).toEqual({
      enabled: false,
      tools: [
        { name: 'get_weather', description: 'Weather', enabled: true },
        { name: 'send_email', description: 'Email', enabled: true }
      ]
    })
  })

  it('shows only HTTP connectors, and acts only on ones it lists', async () => {
    const { store, state } = fakeDesktop()
    expect(await store.read('connectors')).toEqual({
      connectors: [{ id: '1', name: 'Notes', url: 'https://mcp.test/notes', enabled: true }]
    })
    await store.write('connectors', { add: { name: 'Docs', url: 'https://docs.test/mcp' } })
    await store.write('connectors', { setEnabled: { id: '1', enabled: false } })
    await store.write('connectors', { setEnabled: { id: '2', enabled: false } })
    await store.write('connectors', { remove: '2' })
    await store.write('connectors', { remove: '1' })
    expect(state.calls).toEqual([
      'add Docs http https://docs.test/mcp',
      'enable 1 false',
      'remove 1'
    ])
  })

  it('reads and writes Image, Transcription and Voice as the desktop keys them', async () => {
    const { store, state } = fakeDesktop()
    expect(await store.read('image')).toEqual({
      model: 'sdxl',
      size: 1024,
      steps: 28,
      cfgScale: 7,
      seed: '7',
      negative: '',
      enhance: true
    })
    await store.write('image', { steps: 12, negative: 'blurry', enhance: false })
    expect(state.app).toMatchObject({
      imageParams: { sdxl: { steps: 12 } },
      imgNegative: 'blurry',
      enhanceImagePrompts: false
    })
    expect((await store.read('image')) as { steps: number }).toMatchObject({ steps: 12 })

    expect(await store.read('transcription')).toEqual({
      language: 'en',
      languages: [
        { code: 'auto', label: 'Detect' },
        { code: 'en', label: 'English' }
      ]
    })
    await store.write('transcription', { language: 'auto' })
    expect(state.app.sttLanguage).toBe('auto')

    await store.write('voice', { voice: 'bm_george', ttsEnabled: false })
    expect(await store.read('voice')).toEqual({ ttsEnabled: false, voice: 'bm_george' })
  })
})
