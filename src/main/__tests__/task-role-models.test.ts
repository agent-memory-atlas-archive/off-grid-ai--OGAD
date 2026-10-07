// The one place task model roles change. The settings stores are the boundary replaced.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  computer: { groundingModelId: null as string | null, decisionModelId: null as string | null },
  web: { decisionModelId: null as string | null }
}))
vi.mock('../computer-use-settings', () => ({
  getComputerUseSettings: () => ({ ...store.computer }),
  setComputerUseSettings: (next: typeof store.computer) => void (store.computer = next)
}))
vi.mock('../web-use-settings', () => ({
  getWebUseSettings: () => ({ ...store.web }),
  setWebUseSettings: (next: typeof store.web) => void (store.web = next)
}))

import { clearTaskRolesFor, setTaskRoleFromRequest, setTaskRoleModel } from '../task-role-models'

beforeEach(() => {
  store.computer = { groundingModelId: null, decisionModelId: null }
  store.web = { decisionModelId: null }
})

describe('task model roles', () => {
  it('shares one grounding specialist, and keeps a decision model per task', () => {
    setTaskRoleModel('web_use', 'grounding', 'ui-tars')
    expect(store.computer.groundingModelId).toBe('ui-tars')
    setTaskRoleModel('computer_use', 'decision', 'kev-4b')
    setTaskRoleModel('web_use', 'decision', 'jev')
    expect(store.computer.decisionModelId).toBe('kev-4b')
    expect(store.web.decisionModelId).toBe('jev')
  })

  it('clears every role a removed model held, and no other', () => {
    store.computer = { groundingModelId: 'ui-tars', decisionModelId: 'jev' }
    store.web = { decisionModelId: 'jev' }
    clearTaskRolesFor('jev')
    expect(store.computer).toEqual({ groundingModelId: 'ui-tars', decisionModelId: null })
    expect(store.web.decisionModelId).toBeNull()
  })

  it('sets a role asked for over the gateway only when the request names one fully', () => {
    expect(setTaskRoleFromRequest({ task: 'web_use', role: 'decision', modelId: 'jev' })).toEqual({
      success: true
    })
    expect(store.web.decisionModelId).toBe('jev')
    for (const bad of [
      { task: 'chat', role: 'decision', modelId: 'x' },
      { task: 'web_use', role: 'reasoner', modelId: 'x' },
      { task: 'web_use', role: 'decision', modelId: '' }
    ]) {
      expect(setTaskRoleFromRequest(bad).success).toBe(false)
    }
  })
})
