import { useRuntimeBackends } from '../hooks/useRuntimeBackends'
import {
  modelRuntimeBackend,
  runtimeBackendLabel,
  type RuntimeId
} from '../../../shared/runtime-backends'
import { useCallback, useEffect, useState } from 'react'
import { Check, CircleNotch, Cpu, Power, X } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { SidePanel } from './SidePanel'
import { Button } from './ui/button'
import { openModelSettingsPanel } from '@renderer/lib/model-settings-panel'
import { TaskLineups } from './TaskLineups'
import { useTaskRoles } from '../lib/task-roles'
import { resolveActiveTextModel } from '../lib/model-summary'
import { invalidateLlmSettings } from '../lib/settings-invalidation'
import { Field, FieldError } from '@offgrid/operator-ui/operator/coss/field'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (): any => (window as any).api

interface ModelFile {
  name: string
  role?: string
}
interface ModelEntry {
  id: string
  name: string
  kind: string
  files?: ModelFile[]
  remoteServerId?: string
  grounder?: boolean
  tags?: string[]
  availability?: 'ready' | 'coming_soon'
}

// The text/vision LLM is selected by catalog id (it reloads llama-server); image
// and transcription runtimes resolve by FILENAME on disk; voice is one engine.
const MODALITIES: {
  label: string
  kinds: string[]
  mode: 'text' | 'image' | 'speech' | 'transcription'
}[] = [
  { label: 'Text & Vision', kinds: ['text', 'vision'], mode: 'text' },
  { label: 'Image', kinds: ['image'], mode: 'image' },
  { label: 'Voice', kinds: ['voice', 'speech'], mode: 'speech' },
  { label: 'Transcription', kinds: ['transcription'], mode: 'transcription' }
]
type PickerMode = (typeof MODALITIES)[number]['mode']

// Picker mode -> runtime Modality (the id the unload/residency seam uses). One map,
// so the composer chip / panel / any future surface all resolve unload the same way.
const MODE_TO_MODALITY: Record<PickerMode, string> = {
  text: 'llm',
  image: 'image',
  speech: 'tts',
  transcription: 'stt'
}

// Per-modality unload status. Absent = loaded/idle. Kept as a map keyed by mode so each
// modality is independent — unloading one must NOT reset another's state.
type UnloadStatus = 'unloading' | 'unloaded' | 'error'

function primaryFile(m: ModelEntry): string {
  return m.files?.find((f) => f.role === 'primary')?.name ?? m.files?.[0]?.name ?? m.id
}

function primaryVariant(m: ModelEntry): string | null {
  const file = primaryFile(m)
  if (!file.toLowerCase().endsWith('.gguf')) return null
  return file.slice(0, -'.gguf'.length).split('-').at(-1) ?? null
}

const EASE = [0.16, 1, 0.3, 1] as const

function openSettings(onClose: () => void): void {
  onClose()
  openModelSettingsPanel('model')
}

export function ModelPicker({ onClose }: { onClose: () => void }): React.ReactElement {
  const backends = useRuntimeBackends()
  const backendFor = (id: RuntimeId, modelIds: string[]): string =>
    runtimeBackendLabel(modelRuntimeBackend(backends, id, modelIds))
  const [models, setModels] = useState<ModelEntry[]>([])
  const [installed, setInstalled] = useState<string[]>([])
  // The active selection per modality: id for text, filename for image/STT.
  const [active, setActive] = useState<Record<string, string | null>>({})
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [unload, setUnload] = useState<Record<string, UnloadStatus>>({})
  const [taskRoles, reloadTaskRoles] = useTaskRoles()
  const reduceMotion = useReducedMotion()
  // Rows rise in as the catalog arrives; status marks pop between states.
  const rowMotion = reduceMotion
    ? { initial: false as const, transition: { duration: 0 } }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0 },
        transition: { duration: 0.4, ease: EASE }
      }
  const markMotion = reduceMotion
    ? { initial: false as const, transition: { duration: 0 } }
    : {
        initial: { opacity: 0, scale: 0.5 },
        animate: { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.5 },
        transition: { type: 'spring' as const, stiffness: 500, damping: 28 }
      }

  const load = useCallback(async () => {
    const cat = await api().getModelCatalog?.()
    const catalogModels: ModelEntry[] = cat?.models ?? []
    setModels(catalogModels)
    setInstalled((await api().getInstalledModels?.()) ?? [])
    const text = await api().getActiveModel?.()
    const modal = (await api().getActiveModalities?.()) ?? {}
    const nextActiveIds = new Set<string>((await api().getActiveModelIds?.()) ?? [])
    const remoteTextActive = resolveActiveTextModel(catalogModels, text, nextActiveIds).remote
    setActiveIds(nextActiveIds)
    setActive({
      text: remoteTextActive ? null : (text ?? modal.text ?? null),
      image: modal.image ?? null,
      speech: modal.speech ?? null,
      transcription: modal.transcription ?? null,
      computer_use: modal.computer_use ?? null
    })
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const setUnloadStatus = (mode: string, status: UnloadStatus): void =>
    setUnload((s) => ({ ...s, [mode]: status }))
  const clearUnloadStatus = (mode: string): void =>
    setUnload((s) => {
      if (!(mode in s)) {
        return s
      }
      const next = { ...s }
      delete next[mode]
      return next
    })

  const choose = async (mode: PickerMode, m: ModelEntry): Promise<void> => {
    setBusy(m.id)
    setSelectionError(null)
    clearUnloadStatus(mode) // re-selecting reloads this modality on next use
    try {
      if (mode === 'text') {
        const result = await api().activateModel?.(m.id)
        if (!result?.success) {
          throw new Error(result?.error ?? 'Model selection is unavailable. Restart the app.')
        }
        if (result.success) {
          setActive((current) => ({ ...current, text: m.remoteServerId ? null : m.id }))
          setActiveIds(new Set((await api().getActiveModelIds?.()) ?? []))
          await load()
          invalidateLlmSettings()
        }
      } else {
        const fname = primaryFile(m)
        if (m.remoteServerId) {
          const result = await api().activateModel?.(m.id)
          if (!result?.success) {
            throw new Error(result?.error ?? 'Model selection is unavailable. Restart the app.')
          }
          await load()
        } else {
          await api().setActiveModalModel?.(mode, fname)
          setActive((a) => ({ ...a, [mode]: fname }))
        }
      }
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : 'Could not select the model.')
    } finally {
      setBusy(null)
    }
  }

  // Unload one modality's model from memory now (frees RAM; reloads on next use).
  // Independent per modality — writes only this mode's status.
  const unloadModel = async (mode: PickerMode): Promise<void> => {
    const bridge = api()
    if (typeof bridge?.unloadRuntime !== 'function') {
      // Preload method missing — surface it instead of a silent no-op (there'd be no
      // IPC call and no log). Happens until the app is restarted after preload changed.
      setUnloadStatus(mode, 'error')
      console.error('[models] unloadRuntime is unavailable — restart the app')
      return
    }
    setUnloadStatus(mode, 'unloading')
    try {
      const freed = await bridge.unloadRuntime(MODE_TO_MODALITY[mode])
      console.log(
        `[models] unload ${mode} (${MODE_TO_MODALITY[mode]}):`,
        freed ? 'freed' : 'nothing loaded'
      )
      setUnloadStatus(mode, 'unloaded')
    } catch (e) {
      console.error('[models] unload failed', e)
      setUnloadStatus(mode, 'error')
    }
  }

  return (
    <SidePanel ariaLabel="Active models" onClose={onClose} className="w-[30vw] min-w-[420px]">
      <div className="flex items-center justify-between gap-4 border-b border-neutral-900 px-6 py-4">
        <div className="flex items-center gap-2 text-sm text-white">
          <Cpu className="h-4 w-4 text-green-500" aria-hidden /> Active models
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" size="sm" variant="outline" onClick={() => openSettings(onClose)}>
            Settings
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex-1 space-y-10 overflow-y-auto px-6 py-6">
        <AnimatePresence initial={false}>
          {selectionError && (
            <motion.div
              key="selection-error"
              initial={{ opacity: 0, height: 0, filter: 'blur(4px)' }}
              animate={{ opacity: 1, height: 'auto', filter: 'blur(0px)' }}
              exit={{ opacity: 0, height: 0, filter: 'blur(4px)' }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <Field invalid>
                <FieldError match role="alert">
                  {selectionError}
                </FieldError>
              </Field>
            </motion.div>
          )}
        </AnimatePresence>
        <TaskLineups
          view={taskRoles}
          models={models}
          installed={installed}
          onChanged={async () => {
            await reloadTaskRoles()
            await load()
          }}
          localDetail={(slot) =>
            backendFor(
              slot.role === 'reasoner'
                ? 'chat'
                : slot.role === 'decision'
                  ? 'decision'
                  : 'grounding',
              [
                slot.modelId,
                ...(models.find((m) => m.id === slot.modelId)?.files ?? []).map((f) => f.name)
              ]
            )
          }
        />
        {MODALITIES.map(({ label, kinds, mode }) => {
          const list = models.filter((m) => kinds.includes(m.kind) && installed.includes(m.id))
          const duplicateNames = new Set(
            list
              .filter((m, index) =>
                list.some((other, otherIndex) => otherIndex !== index && other.name === m.name)
              )
              .map((m) => m.name)
          )
          const cur = active[mode]
          const status = unload[mode]
          const isActive = (m: ModelEntry): boolean =>
            mode === 'text'
              ? m.remoteServerId
                ? activeIds.has(m.id)
                : cur === m.id
              : cur === primaryFile(m)
          return (
            <Section
              key={mode}
              label={label}
              actions={
                cur ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => void unloadModel(mode)}
                    disabled={status === 'unloading' || status === 'unloaded'}
                    title={
                      status === 'error'
                        ? 'Unload unavailable — restart the app'
                        : status === 'unloaded'
                          ? 'Already unloaded — reloads on next use'
                          : 'Unload from memory now — frees RAM; reloads on next use'
                    }
                    className={
                      status === 'error' ? 'text-amber-400' : 'text-neutral-500 hover:text-red-400'
                    }
                  >
                    {status === 'unloading' ? (
                      <CircleNotch className="h-3 w-3 animate-spin" />
                    ) : (
                      <Power className="h-3 w-3" />
                    )}
                    <TextMorph as="span">
                      {status === 'error' ? 'Restart to unload' : 'Unload'}
                    </TextMorph>
                  </Button>
                ) : null
              }
            >
              {list.length === 0 ? (
                <p className="text-xs text-neutral-500">
                  No {label.toLowerCase()} model downloaded — get one in Models.
                </p>
              ) : (
                <div className="space-y-2">
                  <AnimatePresence initial={false}>
                    {list.map((m) => (
                      <motion.div key={m.id} layout={!reduceMotion} {...rowMotion}>
                        <button
                          aria-pressed={isActive(m)}
                          disabled={busy !== null}
                          onClick={() => choose(mode, m)}
                          className={`flex w-full items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left text-xs transition-colors duration-300 ${
                            isActive(m)
                              ? 'border-green-500/50 bg-green-500/5 text-white'
                              : 'border-neutral-800 text-neutral-300 hover:bg-neutral-900/60'
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0">
                              <span className="block truncate text-[13px]">{m.name}</span>
                              {!m.remoteServerId && (
                                <span className="mt-0.5 block whitespace-normal text-xs text-neutral-500">
                                  {backendFor(mode === 'text' ? 'chat' : mode, [
                                    m.id,
                                    primaryFile(m),
                                    ...(mode === 'speech' ? ['Kokoro'] : [])
                                  ])}
                                </span>
                              )}
                            </span>
                            {duplicateNames.has(m.name) && primaryVariant(m) ? (
                              <span
                                className="shrink-0 text-xs text-neutral-500"
                                title={primaryFile(m)}
                              >
                                {primaryVariant(m)}
                              </span>
                            ) : null}
                            {m.remoteServerId ? (
                              <Badge variant="success" size="sm" className="shrink-0">
                                Remote
                              </Badge>
                            ) : null}
                          </span>
                          <AnimatePresence mode="popLayout" initial={false}>
                            {busy === m.id ? (
                              <motion.span key="busy" className="flex shrink-0" {...markMotion}>
                                <CircleNotch className="h-3.5 w-3.5 animate-spin text-neutral-500" />
                              </motion.span>
                            ) : isActive(m) && status === 'unloaded' ? (
                              // Still the active selection, but freed from memory — one coherent
                              // state, not a green check next to an "unloaded" label.
                              <motion.span key="unloaded" className="flex shrink-0" {...markMotion}>
                                <Badge variant="outline" size="sm">
                                  <Power className="h-3 w-3" /> Unloaded
                                </Badge>
                              </motion.span>
                            ) : isActive(m) ? (
                              <motion.span key="active" className="flex shrink-0" {...markMotion}>
                                <Check className="h-3.5 w-3.5 text-green-500" weight="bold" />
                              </motion.span>
                            ) : null}
                          </AnimatePresence>
                        </button>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              )}
            </Section>
          )
        })}
        <section aria-label="Embeddings">
          <Section label="Embeddings">
            <div className="rounded-lg border border-neutral-800 px-4 py-3 text-xs text-neutral-300">
              <span className="block text-[13px]">Search and RAG</span>
              <span className="mt-0.5 block text-xs text-neutral-500">
                {runtimeBackendLabel(backends.find((value) => value.id === 'embeddings'))}
              </span>
            </div>
          </Section>
        </section>
        <p className="text-xs leading-relaxed text-neutral-500">
          Your selected Text &amp; Vision model handles chat and supported vision work. Image,
          Voice, and Transcription use their selected models.
        </p>
      </div>
    </SidePanel>
  )
}
