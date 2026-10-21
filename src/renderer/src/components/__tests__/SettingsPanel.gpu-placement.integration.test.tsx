// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { SettingsPanel } from '../SettingsPanel'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

// The preload bridge is the boundary: behind it, main saves the setting and relaunches the
// engine, which then reports the layers it placed.
function installBridge(): void {
  let llmSettings: Record<string, unknown> = {
    gpuPlacement: 'auto',
    gpuLayers: 99,
    gpuOffload: { layers: 49, total: 49 }
  }
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'darwin',
    bestSettingsStatus: async () => ({ applied: true }),
    backendPreferencesGet: async () => ({}),
    backendPreferenceSet: async () => ({}),
    runtimeBackends: async () => [],
    getLlmSettings: async () => llmSettings,
    setLlmSettings: async (patch: Record<string, unknown>) => {
      llmSettings = {
        ...llmSettings,
        ...patch,
        gpuOffload:
          patch.gpuPlacement === 'manual'
            ? { layers: Math.min(49, Number(llmSettings.gpuLayers)), total: 49 }
            : llmSettings.gpuOffload
      }
    },
    getModelCatalog: async () => ({ models: [] }),
    getActiveModel: async () => null,
    getSettings: async () => ({}),
    getTranscriptionInfo: async () => null,
    listTools: async () => [],
    mcpList: async () => []
  }
}

it('shows the layers the engine placed under Auto, and the layer slider under Manual', async () => {
  installBridge()
  render(<SettingsPanel embedded onClose={() => {}} />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /^Performance/ }))

  const auto = await screen.findByRole('switch', { name: 'Place GPU layers automatically' })
  expect(auto.getAttribute('aria-checked')).toBe('true')
  await waitFor(() => expect(screen.getByLabelText('GPU layers in use').textContent).toBe('49/49'))
  expect(screen.queryByRole('slider', { name: 'GPU layers' })).toBeNull()

  await user.click(auto)

  await waitFor(() => expect(auto.getAttribute('aria-checked')).toBe('false'))
  expect(await screen.findByRole('slider', { name: 'GPU layers' })).toBeTruthy()
  expect(screen.queryByLabelText('GPU layers in use')).toBeNull()
})
