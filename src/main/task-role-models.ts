// The one place a task model role is set or cleared. Web Use and Computer Use share one grounding
// specialist; each has its own decision model. The Models screens, Active models, Tasks settings
// and a paired browser all change roles through here, so they can never disagree.

import type { TaskModelRole } from '../shared/computer-use-settings'
import { getComputerUseSettings, setComputerUseSettings } from './computer-use-settings'
import { getWebUseSettings, setWebUseSettings } from './web-use-settings'

export type TaskKind = 'computer_use' | 'web_use'

/** Give `modelId` a role. Grounding is shared by both tasks, whichever one is named. */
export function setTaskRoleModel(task: TaskKind, role: TaskModelRole, modelId: string): void {
  if (role === 'grounding') {
    setComputerUseSettings({ ...getComputerUseSettings(), groundingModelId: modelId })
  } else if (task === 'computer_use') {
    setComputerUseSettings({ ...getComputerUseSettings(), decisionModelId: modelId })
  } else {
    setWebUseSettings({ ...getWebUseSettings(), decisionModelId: modelId })
  }
}

/** A model that is gone leaves every role it held: each falls back to its default. */
export function clearTaskRolesFor(modelId: string): void {
  const computer = getComputerUseSettings()
  if (computer.groundingModelId === modelId || computer.decisionModelId === modelId) {
    setComputerUseSettings({
      ...computer,
      groundingModelId: computer.groundingModelId === modelId ? null : computer.groundingModelId,
      decisionModelId: computer.decisionModelId === modelId ? null : computer.decisionModelId
    })
  }
  const web = getWebUseSettings()
  if (web.decisionModelId === modelId) setWebUseSettings({ ...web, decisionModelId: null })
}

/** Whether `modelId` can fill `role`: an installed or remote task model of that kind (a decision
 *  model carries the Decision tag; a grounding specialist does not). */
export async function canFillTaskRole(modelId: string, role: TaskModelRole): Promise<boolean> {
  const { getCatalog, listInstalled } = await import('./models-manager')
  const [catalog, installed] = await Promise.all([getCatalog(), listInstalled()])
  const models = catalog.models as Array<{ id?: string; kind?: string; tags?: readonly string[] }>
  const entry = models.find((model) => model.id === modelId)
  if (!entry || entry.kind !== 'computer_use' || !installed.includes(modelId)) return false
  return (entry.tags?.includes('Decision') ?? false) === (role === 'decision')
}

/** A role change asked for over IPC, the local gateway or a paired browser: checked, then set. */
export async function setTaskRoleFromRequest(request: {
  task?: unknown
  role?: unknown
  modelId?: unknown
}): Promise<{ success: boolean; error?: string }> {
  const { task, role, modelId } = request
  if (
    (task !== 'computer_use' && task !== 'web_use') ||
    (role !== 'decision' && role !== 'grounding') ||
    typeof modelId !== 'string' ||
    !modelId
  ) {
    return { success: false, error: 'Choose a task, a role and a model.' }
  }
  if (!(await canFillTaskRole(modelId, role))) {
    return { success: false, error: 'That model cannot fill this role.' }
  }
  setTaskRoleModel(task, role, modelId)
  return { success: true }
}
