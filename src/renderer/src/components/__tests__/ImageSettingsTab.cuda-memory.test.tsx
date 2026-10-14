// @vitest-environment jsdom
/**
 * On CUDA the chat and image models stay loaded together, so choosing an image model there
 * carries a note that both share GPU memory. Machines on any other backend never see it.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeBackend } from '../../../../shared/runtime-backends'
import { ImageSettingsTab } from '../ImageSettingsTab'

const MODEL = 'sd-turbo-Q8_0.gguf'
const NOTE = /share GPU memory/

function openOn(runtimes: RuntimeBackend[]): void {
  window.api = {
    imageGenStatus: async () => ({ models: [MODEL], active: MODEL }),
    getSettings: async () => ({}),
    getModelCatalog: async () => ({ models: [] }),
    saveSetting: async () => true,
    setActiveModalModel: async () => true,
    runtimeBackends: async () => runtimes
  } as never
  render(<ImageSettingsTab />)
}

afterEach(cleanup)

describe('<ImageSettingsTab/> CUDA memory note', () => {
  it('warns that both models share GPU memory when the chat engine runs on CUDA', async () => {
    openOn([
      {
        id: 'chat',
        model: 'qwen3-8b-Q4_K_M.gguf',
        state: 'loaded',
        backend: 'CUDA',
        device: 'RTX 3060'
      }
    ])
    expect(await screen.findByText(NOTE)).toBeTruthy()
  })

  it('says nothing about GPU memory on Metal', async () => {
    openOn([
      {
        id: 'chat',
        model: 'qwen3-8b-Q4_K_M.gguf',
        state: 'loaded',
        backend: 'Metal',
        device: 'Apple M3'
      }
    ])
    await screen.findByLabelText('Active image model')
    expect(screen.queryByText(NOTE)).toBeNull()
  })
})
