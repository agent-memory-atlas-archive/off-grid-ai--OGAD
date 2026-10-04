// A paired browser's view of the desktop's settings (sealed settings.get / settings.set). The
// browser sees and changes the same values as Settings here, through the same functions:
// Tasks, Tools, Connectors, Image, Transcription and Voice. The patch arriving here has
// already been checked by bridge-settings.ts (listed keys, types, bounds); the setters below
// normalise it as they do for the desktop's own screen.
//
// Pure apart from the injected desktop functions (bridge-electron.ts wires the real ones),
// so it is tested without Electron or a database.

import type { SettingsBySection, SettingsSection, TaskOptions } from './bridge-settings'

type Patch = Record<string, unknown>

export interface SettingsStoreDeps {
  web(): TaskOptions & { browserTarget: 'in_app' | 'default_browser' }
  setWeb(next: unknown): void
  computer(): TaskOptions & { showPictureInPicture: boolean; enabledRails: string[] }
  setComputer(next: unknown): void
  appSettings(): Record<string, unknown>
  saveSetting(key: string, value: unknown): void
  listTools(): { name: string; description: string; enabled: boolean }[]
  setToolEnabled(name: string, enabled: boolean): void
  listConnectors(): { id: number; name: string; url: string | null; enabled: number }[]
  addConnector(c: { name: string; transport: 'http'; url: string }): void
  setConnectorEnabled(id: number, enabled: boolean): void
  removeConnector(id: number): void
  activeImageModel(): string | null
  imageParams(model: string, store: unknown): { size: number; steps: number; cfgScale: number }
  setImageParam(
    store: unknown,
    model: string,
    key: 'size' | 'steps' | 'cfgScale',
    value: number
  ): unknown
  transcription(): Promise<{
    language: string
    languages: readonly { code: string; label: string }[]
  }>
}

const TASK_KEYS = [
  'modelStrategy',
  'context',
  'screenshotSize',
  'visualHistoryFrames',
  'checkpointInterval'
] as const

function taskOptions(s: TaskOptions): TaskOptions {
  return {
    modelStrategy: s.modelStrategy,
    context: s.context,
    screenshotSize: s.screenshotSize,
    visualHistoryFrames: s.visualHistoryFrames,
    checkpointInterval: s.checkpointInterval
  }
}

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

export function createSettingsStore(deps: SettingsStoreDeps): {
  read(section: SettingsSection): Promise<SettingsBySection[SettingsSection]>
  write(section: SettingsSection, patch: Patch): Promise<void>
} {
  const readers: {
    [S in SettingsSection]: () => Promise<SettingsBySection[S]> | SettingsBySection[S]
  } = {
    tasks: () => {
      const web = deps.web()
      const computer = deps.computer()
      return {
        web: { ...taskOptions(web), browserTarget: web.browserTarget },
        computer: {
          ...taskOptions(computer),
          showPictureInPicture: computer.showPictureInPicture,
          enabledRails: [...computer.enabledRails]
        }
      }
    },
    tools: () => ({
      enabled: deps.appSettings().toolsEnabled !== false,
      tools: deps
        .listTools()
        .map((t) => ({ name: t.name, description: t.description, enabled: t.enabled }))
    }),
    connectors: () => ({
      // Only HTTP connectors are shown: a local command's path and arguments stay on the desktop.
      connectors: deps
        .listConnectors()
        .filter((c) => typeof c.url === 'string' && c.url)
        .map((c) => ({
          id: String(c.id),
          name: c.name,
          url: c.url as string,
          enabled: c.enabled === 1
        }))
    }),
    image: () => {
      const settings = deps.appSettings()
      const model = deps.activeImageModel()
      const params = model
        ? deps.imageParams(model, settings.imageParams)
        : { size: 512, steps: 28, cfgScale: 7 }
      return {
        model,
        ...params,
        seed: str(settings.imgSeed, ''),
        negative: str(settings.imgNegative, ''),
        enhance: settings.enhanceImagePrompts !== false
      }
    },
    transcription: async () => {
      const info = await deps.transcription()
      return {
        language: info.language,
        languages: info.languages.map((l) => ({ code: l.code, label: l.label }))
      }
    },
    voice: () => {
      const settings = deps.appSettings()
      return {
        ttsEnabled: settings.ttsEnabled !== false,
        voice: str(settings.ttsVoice, 'af_heart')
      }
    }
  }

  const writers: Record<SettingsSection, (patch: Patch) => void> = {
    tasks: (p) => {
      if (p.web) deps.setWeb({ ...deps.web(), ...pickTask(p.web, ['browserTarget']) })
      if (p.computer) {
        deps.setComputer({
          ...deps.computer(),
          ...pickTask(p.computer, ['showPictureInPicture', 'enabledRails'])
        })
      }
    },
    tools: (p) => {
      if (typeof p.enabled === 'boolean') deps.saveSetting('toolsEnabled', p.enabled)
      const tool = p.tool as { name: string; enabled: boolean } | undefined
      if (tool && deps.listTools().some((t) => t.name === tool.name)) {
        deps.setToolEnabled(tool.name, tool.enabled)
      }
    },
    connectors: (p) => {
      const add = p.add as { name: string; url: string } | undefined
      if (add) deps.addConnector({ name: add.name, transport: 'http', url: add.url })
      const toggle = p.setEnabled as { id: string; enabled: boolean } | undefined
      if (toggle && known(toggle.id)) deps.setConnectorEnabled(Number(toggle.id), toggle.enabled)
      if (typeof p.remove === 'string' && known(p.remove)) deps.removeConnector(Number(p.remove))
    },
    image: (p) => {
      const model = deps.activeImageModel()
      let store = deps.appSettings().imageParams
      for (const key of ['size', 'steps', 'cfgScale'] as const) {
        if (model && typeof p[key] === 'number')
          store = deps.setImageParam(store, model, key, p[key])
      }
      if (store !== deps.appSettings().imageParams) deps.saveSetting('imageParams', store)
      if (typeof p.seed === 'string') deps.saveSetting('imgSeed', p.seed)
      if (typeof p.negative === 'string') deps.saveSetting('imgNegative', p.negative)
      if (typeof p.enhance === 'boolean') deps.saveSetting('enhanceImagePrompts', p.enhance)
    },
    transcription: (p) => {
      if (typeof p.language === 'string') deps.saveSetting('sttLanguage', p.language)
    },
    voice: (p) => {
      if (typeof p.ttsEnabled === 'boolean') deps.saveSetting('ttsEnabled', p.ttsEnabled)
      if (typeof p.voice === 'string') deps.saveSetting('ttsVoice', p.voice)
    }
  }

  // Connector ids arrive as strings; only an id the desktop lists, and only an HTTP one, counts.
  const known = (id: string): boolean =>
    deps.listConnectors().some((c) => String(c.id) === id && typeof c.url === 'string' && c.url)

  return {
    read: async (section) => readers[section](),
    async write(section, patch) {
      writers[section](patch)
    }
  }
}

function pickTask(raw: unknown, extra: readonly string[]): Patch {
  const p = (raw ?? {}) as Patch
  const out: Patch = {}
  for (const key of [...TASK_KEYS, ...extra]) {
    if (Object.hasOwn(p, key)) out[key] = p[key]
  }
  return out
}
