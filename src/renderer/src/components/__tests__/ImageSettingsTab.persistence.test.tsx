// @vitest-environment jsdom
/**
 * Image fine-tuning edits must survive closing Settings. Esc or an outside click unmounts the
 * field without a blur, so the typed value has to be saved before the field goes away.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImageSettingsTab } from '../ImageSettingsTab'

const MODEL = 'qwen-image-2.1-turbo-Q4_K_M.gguf'
let settings: Record<string, unknown>

beforeEach(() => {
  settings = {}
  window.api = {
    imageGenStatus: async () => ({ models: [MODEL], active: MODEL }),
    getSettings: async () => structuredClone(settings),
    getModelCatalog: async () => ({ models: [] }),
    saveSetting: async (key: string, value: unknown) => {
      settings[key] = structuredClone(value)
      return true
    },
    setActiveModalModel: async () => true,
    getBackendPreferences: async () => ({}),
    getHardwareBackends: async () => []
  } as never
})

afterEach(cleanup)

/** The section remembers whether it was open, so only open it when it is closed. */
async function openFineTuning(): Promise<void> {
  const toggle = await screen.findByText('Fine tuning')
  if (!screen.queryByLabelText('Image steps')) fireEvent.click(toggle)
}

describe('<ImageSettingsTab/> fine tuning', () => {
  it('keeps typed steps and guidance after Settings closes without a blur', async () => {
    const first = render(<ImageSettingsTab />)
    await openFineTuning()
    fireEvent.change(screen.getByLabelText('Image steps'), { target: { value: '8' } })
    fireEvent.change(screen.getByLabelText('Image guidance'), { target: { value: '1.5' } })
    first.unmount()

    render(<ImageSettingsTab />)
    await openFineTuning()
    expect(await screen.findByText('8 steps · guidance 1.5 · random seed')).toBeTruthy()
    expect((screen.getByLabelText('Image steps') as HTMLInputElement).value).toBe('8')
    expect((screen.getByLabelText('Image guidance') as HTMLInputElement).value).toBe('1.5')
  })

  it('does not save a partial value outside the allowed range while typing', async () => {
    render(<ImageSettingsTab />)
    await openFineTuning()
    fireEvent.change(screen.getByLabelText('Image steps'), { target: { value: '1' } })
    expect(settings.imageParams).toBeUndefined()
  })
})
