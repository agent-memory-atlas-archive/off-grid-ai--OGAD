// SHARED VERBATIM with off-grid-ai/browser-extension src/shared/bridge/settings.ts. Change both.
// Off Grid AI Desktop's settings, as a paired browser sees and changes them (sealed RPC
// `settings.get` / `settings.set`). The panel's Settings tabs mirror the desktop's: Tasks,
// Tools, Connectors, Image, Transcription and Voice. Text stays on the gateway's /v1/settings.
//
// THIS FILE IS SHARED VERBATIM with the desktop (src/main/extension-bridge/bridge-settings.ts).
// Change both, or neither.
//
// The desktop is the authority. A browser may only send the keys listed here, with these
// types and bounds; the desktop then saves them through the same functions its own Settings
// screen uses, which normalise every value. API keys, file paths and model downloads are not
// reachable from here.

export const SETTINGS_SECTIONS = [
  'tasks',
  'tools',
  'connectors',
  'image',
  'transcription',
  'voice'
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const isSettingsSection = (v: unknown): v is SettingsSection =>
  (SETTINGS_SECTIONS as readonly unknown[]).includes(v)

// ---- What the desktop answers ---------------------------------------------------------------

/** Web Use and Computer Use options with fixed choices (the desktop's Tasks tab). */
export interface TaskOptions {
  readonly modelStrategy: string
  readonly context: string
  readonly screenshotSize: string
  readonly visualHistoryFrames: number
  readonly checkpointInterval: number
}

export interface TasksSettings {
  readonly web: TaskOptions & { readonly browserTarget: 'in_app' | 'default_browser' }
  readonly computer: TaskOptions & {
    readonly showPictureInPicture: boolean
    readonly enabledRails: readonly string[]
  }
}

export interface ToolsSettings {
  readonly enabled: boolean
  readonly tools: readonly { name: string; description: string; enabled: boolean }[]
}

export interface ConnectorsSettings {
  readonly connectors: readonly { id: string; name: string; url: string; enabled: boolean }[]
}

export interface ImageSettings {
  /** The active image model, or null when none is set up. */
  readonly model: string | null
  readonly size: number
  readonly steps: number
  readonly cfgScale: number
  readonly seed: string
  readonly negative: string
  readonly enhance: boolean
}

export interface TranscriptionSettings {
  readonly language: string
  /** What the active transcription model understands; 'auto' detects it. */
  readonly languages: readonly { code: string; label: string }[]
}

export interface VoiceSettings {
  readonly ttsEnabled: boolean
  readonly voice: string
}

export interface SettingsBySection {
  tasks: TasksSettings
  tools: ToolsSettings
  connectors: ConnectorsSettings
  image: ImageSettings
  transcription: TranscriptionSettings
  voice: VoiceSettings
}

// ---- What a browser may send ----------------------------------------------------------------

export const TASK_STRATEGIES = [
  'same_as_chat',
  'separate_specialist',
  'text_plus_specialist',
  'decision_plus_specialist',
  'decision_plus_reasoning'
] as const
export const TASK_CONTEXTS = ['auto', '16k', '32k'] as const
export const SCREENSHOT_SIZES = ['compact', 'balanced', 'large'] as const
export const VISUAL_HISTORY = [0, 1, 2, 5, 10] as const
export const CHECKPOINTS = [8, 9, 10] as const
export const RAILS = ['ax', 'vision'] as const
export const BROWSER_TARGETS = ['in_app', 'default_browser'] as const
export const IMAGE_SIZES = [256, 512, 640, 768, 1024] as const

type Patch = Record<string, unknown>
type Rule = (v: unknown) => unknown | undefined

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const oneOf =
  <T>(choices: readonly T[]): Rule =>
  (v) =>
    choices.includes(v as T) ? v : undefined
const bool: Rule = (v) => (typeof v === 'boolean' ? v : undefined)
const text =
  (max: number, pattern?: RegExp): Rule =>
  (v) =>
    typeof v === 'string' && v.length <= max && (!pattern || pattern.test(v)) ? v : undefined
const int =
  (min: number, max: number): Rule =>
  (v) =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v : undefined
const num =
  (min: number, max: number): Rule =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined
const rails: Rule = (v) =>
  Array.isArray(v) && v.length > 0 && v.every((r) => (RAILS as readonly unknown[]).includes(r))
    ? [...new Set(v)]
    : undefined

/** Keep the listed keys that pass their rule. Null when nothing valid is left. */
function pick(raw: unknown, rules: Record<string, Rule>): Patch | null {
  if (!isObj(raw)) {
    return null
  }
  const out: Patch = {}
  for (const [key, rule] of Object.entries(rules)) {
    if (Object.hasOwn(raw, key)) {
      const value = rule(raw[key])
      if (value !== undefined) {
        out[key] = value
      }
    }
  }
  return Object.keys(out).length ? out : null
}

const TASK_RULES: Record<string, Rule> = {
  modelStrategy: oneOf(TASK_STRATEGIES),
  context: oneOf(TASK_CONTEXTS),
  screenshotSize: oneOf(SCREENSHOT_SIZES),
  visualHistoryFrames: oneOf(VISUAL_HISTORY),
  checkpointInterval: oneOf(CHECKPOINTS)
}

const nested =
  (rules: Record<string, Rule>): Rule =>
  (v) =>
    pick(v, rules) ?? undefined

const HTTP_URL = /^https?:\/\/[^\s]+$/

const SECTION_RULES: Record<SettingsSection, Record<string, Rule>> = {
  tasks: {
    web: nested({ ...TASK_RULES, browserTarget: oneOf(BROWSER_TARGETS) }),
    computer: nested({ ...TASK_RULES, showPictureInPicture: bool, enabledRails: rails })
  },
  tools: {
    enabled: bool,
    tool: nested({ name: text(200, /^\S+$/), enabled: bool })
  },
  connectors: {
    add: nested({ name: text(80, /\S/), url: text(2000, HTTP_URL) }),
    setEnabled: nested({ id: text(100, /^\S+$/), enabled: bool }),
    remove: text(100, /^\S+$/)
  },
  image: {
    size: oneOf(IMAGE_SIZES),
    steps: int(1, 50),
    cfgScale: num(0, 20),
    seed: text(12, /^\d*$/),
    negative: text(2000),
    enhance: bool
  },
  transcription: { language: text(12, /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/) },
  voice: { ttsEnabled: bool, voice: text(64, /^[\w.-]+$/) }
}

/**
 * The part of a browser's patch the desktop may apply: listed keys, valid values, nothing
 * else. A nested change (a tool switch, a connector) must be whole to count. Null when
 * nothing valid is left, which the desktop refuses as invalid.
 */
export function parseSettingsPatch(section: SettingsSection, raw: unknown): Patch | null {
  const patch = pick(raw, SECTION_RULES[section])
  if (!patch) {
    return null
  }
  const whole: Record<string, readonly string[]> = {
    tool: ['name', 'enabled'],
    add: ['name', 'url'],
    setEnabled: ['id', 'enabled']
  }
  for (const [key, needs] of Object.entries(whole)) {
    const v = patch[key]
    if (isObj(v) && !needs.every((n) => Object.hasOwn(v, n))) {
      delete patch[key]
    }
  }
  return Object.keys(patch).length ? patch : null
}
