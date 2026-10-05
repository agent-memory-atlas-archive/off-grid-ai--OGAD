// What a paired browser may pick for Remote and the Tasks models, built the same way as
// Settings > Remote and Settings > Tasks here (pro ComputerUseSettingsSection): installed
// local models plus each saved remote server's role models. Pure, so it is tested without
// Electron.

import { remoteVisionModelId } from '../../shared/remote-vision-server'
import type { ModelChoice, RemoteSettings } from './bridge-settings'

/** A saved remote server, as the desktop keeps it. Only name, host and model names leave. */
export interface SavedServer {
  readonly id: string
  readonly name: string
  readonly endpoint: string
  readonly model: string
  readonly enabled?: boolean
  readonly roleModels?: Partial<Record<string, string>>
  readonly modelCatalog?: readonly { id: string; name: string }[]
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return ''
  }
}

const modelName = (server: SavedServer, id: string): string =>
  server.modelCatalog?.find((m) => m.id === id)?.name ?? id

export function remoteView(
  servers: readonly SavedServer[],
  activeServerId: string | null,
  textOnRemote: boolean
): RemoteSettings {
  const usable = servers.filter((s) => s.enabled !== false)
  const active = textOnRemote && usable.some((s) => s.id === activeServerId)
  return {
    active,
    activeServerId: active ? activeServerId : null,
    servers: usable.map((s) => ({
      id: s.id,
      name: s.name,
      host: hostOf(s.endpoint),
      model: s.model ? modelName(s, s.model) : ''
    }))
  }
}

const isDecision = (m: Record<string, unknown>): boolean =>
  m.kind === 'computer_use' && Array.isArray(m.tags) && m.tags.includes('Decision')

const isGrounder = (m: Record<string, unknown>): boolean =>
  m.grounder === true || (m.kind === 'computer_use' && !isDecision(m))

function localChoices(
  catalog: readonly Record<string, unknown>[],
  installed: ReadonlySet<string>,
  keep: (m: Record<string, unknown>) => boolean
): ModelChoice[] {
  return catalog
    .filter(
      (m) =>
        keep(m) &&
        m.availability !== 'coming_soon' &&
        typeof m.id === 'string' &&
        installed.has(m.id)
    )
    .map((m) => ({ id: String(m.id), label: String(m.name ?? m.id) }))
}

function remoteChoices(servers: readonly SavedServer[], role: string): ModelChoice[] {
  return servers.flatMap((s) => {
    const id = s.roleModels?.[role]
    if (!id || s.enabled === false) {
      return []
    }
    return [{ id: remoteVisionModelId(s.id, id), label: `${modelName(s, id)} - ${s.name}` }]
  })
}

export function taskModelChoices(input: {
  catalog: readonly Record<string, unknown>[]
  installed: readonly string[]
  servers: readonly SavedServer[]
}): { grounding: ModelChoice[]; decision: ModelChoice[] } {
  const installed = new Set(input.installed)
  return {
    grounding: [
      ...localChoices(input.catalog, installed, isGrounder),
      ...remoteChoices(input.servers, 'grounding')
    ],
    decision: [
      ...localChoices(input.catalog, installed, isDecision),
      ...remoteChoices(input.servers, 'decision')
    ]
  }
}
