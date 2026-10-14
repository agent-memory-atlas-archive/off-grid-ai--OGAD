// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'
import { registerSlot, SLOTS } from '../../bootstrap/slotRegistry'
import { normalizeBackendPreferences } from '../../../../shared/backend-preferences'
import type { BackendModality, BackendPreference } from '../../../../shared/backend-preferences'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('places each backend choice with its model settings and saves the selected device', async () => {
  let preferences = normalizeBackendPreferences({}, 'linux')
  const saved: Array<[BackendModality, BackendPreference]> = []
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'linux',
    backendPreferencesGet: async () => preferences,
    backendPreferenceSet: async (modality: BackendModality, preference: BackendPreference) => {
      saved.push([modality, preference])
      preferences = { ...preferences, [modality]: preference }
      return preferences
    },
    runtimeBackends: async () => [],
    getLlmSettings: async () => ({}),
    getModelCatalog: async () => ({ models: [] }),
    getActiveModel: async () => null,
    getSettings: async () => ({}),
    getTranscriptionInfo: async () => null,
    imageGenStatus: async () => ({ available: false, models: [] }),
    ttsVoices: async () => [],
    prepareTtsVoice: async () => ({ ready: true }),
    onTtsVoiceProgress: () => () => {},
    listTools: async () => [],
    mcpList: async () => []
  }

  // Tasks comes from Pro, as the other paid screens do.
  registerSlot(SLOTS.taskSettings, () => <p>Task settings</p>)
  render(<SettingsPanel embedded onClose={() => {}} />)
  const user = userEvent.setup()
  const textBackend = screen.getByRole('combobox', { name: 'Chat and vision backend' })
  expect(textBackend).toBeTruthy()
  expect(
    textBackend.compareDocumentPosition(screen.getByRole('combobox', { name: 'Context window' })) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Images backend' })).toBeNull()

  await user.click(screen.getByRole('radio', { name: 'image' }))
  await user.click(screen.getByRole('button', { name: /^Processing/ }))
  const image = screen.getByRole('combobox', { name: 'Images backend' })
  await user.click(image)
  await user.click(await screen.findByRole('option', { name: 'Vulkan' }))
  await waitFor(() => expect(saved).toContainEqual(['image', 'vulkan']))

  // A single backend row has no section of its own: it sits in the open section beside it.
  await user.click(screen.getByRole('radio', { name: 'voice' }))
  expect(screen.getByRole('combobox', { name: 'Speech backend' })).toBeTruthy()

  await user.click(screen.getByRole('radio', { name: 'transcription' }))
  expect(screen.getByRole('combobox', { name: 'Transcription backend' })).toBeTruthy()

  // The task models' backends sit with the task settings; Tools keeps search embeddings.
  await user.click(screen.getByRole('radio', { name: 'tasks' }))
  await user.click(screen.getByRole('button', { name: /^Task model backends/ }))
  expect(screen.getByRole('combobox', { name: 'Grounding backend' })).toBeTruthy()
  expect(screen.getByRole('combobox', { name: 'Decider backend' })).toBeTruthy()
  await user.click(screen.getByRole('radio', { name: 'tools' }))
  expect(screen.getByRole('combobox', { name: 'Search embeddings backend' })).toBeTruthy()
  expect(screen.queryByRole('combobox', { name: 'Grounding backend' })).toBeNull()

  await user.click(screen.getByRole('radio', { name: 'image' }))
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Images backend' }).textContent).toContain('Vulkan')
  )
})
