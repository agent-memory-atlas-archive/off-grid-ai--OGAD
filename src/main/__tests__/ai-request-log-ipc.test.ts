import { beforeEach, describe, expect, it, vi } from 'vitest'
interface TestWindow {
  destroy: () => void
  loadFile: ReturnType<typeof vi.fn>
  options: unknown
  focus: ReturnType<typeof vi.fn>
  restore: ReturnType<typeof vi.fn>
  webContents: { setWindowOpenHandler: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
}
const state = vi.hoisted(() => ({
  windows: [] as TestWindow[],
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, handler)
  },
  BrowserWindow: class {
    options: unknown
    destroyed = false
    listeners = new Map<string, () => void>()
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() }
    loadURL = vi.fn().mockResolvedValue(undefined)
    loadFile = vi.fn().mockResolvedValue(undefined)
    show = vi.fn()
    focus = vi.fn()
    restore = vi.fn()
    isMinimized = (): boolean => true
    isDestroyed = (): boolean => this.destroyed
    constructor(options: unknown) {
      this.options = options
      state.windows.push(this)
    }
    on(event: string, handler: () => void): void {
      this.listeners.set(event, handler)
    }
    destroy(): void {
      this.destroyed = true
      this.listeners.get('closed')?.()
    }
  }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../preload-path', () => ({ preloadPath: () => '/application/preload.js' }))
vi.mock('../renderer-path', () => ({ rendererHtmlPath: () => '/application/index.html' }))
vi.mock('../ai-request-log-store', () => ({
  listAIRequestLogs: vi.fn((query) => query),
  getAIRequestLog: vi.fn(),
  relatedAIRequests: vi.fn(),
  clearAIRequestLogs: vi.fn(),
  readAIRequestAttachment: vi.fn()
}))
import {
  openAIActivityWindow,
  setupAIRequestLogIPC,
  validateAILogQuery
} from '../ai-request-log-ipc'

beforeEach(() => {
  for (const window of state.windows) window.destroy()
  state.windows.length = 0
  state.handlers.clear()
})
describe('AI activity IPC and independent window', () => {
  it('reuses the window and opens only the activity renderer', async () => {
    await openAIActivityWindow()
    await openAIActivityWindow()
    expect(state.windows).toHaveLength(1)
    const window = state.windows[0]!
    expect(window.loadFile).toHaveBeenCalledWith('/application/index.html', { hash: 'ai-activity' })
    expect(window.options).toMatchObject({
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.webContents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    window.webContents.on.mock.calls[0]![1](event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    window.destroy()
    await openAIActivityWindow()
    expect(state.windows).toHaveLength(2)
  })
  it('limits filters to supported values and finite numbers', () => {
    expect(validateAILogQuery(null)).toEqual({})
    expect(
      validateAILogQuery({
        sort: 'DROP TABLE',
        modality: 'bad',
        since: Infinity,
        status: {},
        offset: -1
      })
    ).toEqual({ offset: 0 })
    expect(
      validateAILogQuery({
        modality: 'image',
        status: 'failed',
        sort: 'slowest',
        hardware: 'gpu',
        limit: 30,
        search: 'dog'
      })
    ).toEqual({
      modality: 'image',
      status: 'failed',
      sort: 'slowest',
      hardware: 'gpu',
      limit: 30,
      search: 'dog'
    })
  })
  it('exposes validated filters and rejects non-string record identifiers', () => {
    setupAIRequestLogIPC()
    expect(state.handlers.get('ai-logs:list')!({}, { search: 'hello', sort: 'unsafe' })).toEqual({
      search: 'hello'
    })
    expect(state.handlers.get('ai-logs:detail')!({}, {})).toBeNull()
    expect(state.handlers.get('ai-logs:attachment')!({}, 'id', {})).toBeNull()
    expect(state.handlers.has('ai-logs:open-window')).toBe(true)
  })
})
