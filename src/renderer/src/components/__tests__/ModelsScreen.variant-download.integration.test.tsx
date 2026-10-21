// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const repo = 'prism-ml/Ternary-Bonsai-2-27B-gguf'
const catalogRepo = 'unsloth/Qwen3.5-9B-GGUF'
const downloadModel = vi.fn(async () => ({ success: true }))
;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb: 32 }),
  getModelCatalog: async () => ({ kinds: ['text'], models: [
    { id: catalogRepo, name: 'Qwen3.5-9B-GGUF', kind: 'text', org: 'unsloth', files: [] }
  ] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => [{ id: repo, name: 'Ternary-Bonsai-2-27B-gguf', org: 'prism-ml' }],
  getModelFiles: async (id: string) => id === catalogRepo ? [
    { fileName: 'Qwen3.5-9B-Q4_K_M.gguf', quant: 'Q4_K_M', sizeBytes: 5_800_000_000 },
    { fileName: 'Qwen3.5-9B-Q8_0.gguf', quant: 'Q8_0', sizeBytes: 9_600_000_000 }
  ] : [
    { fileName: 'Ternary-Bonsai-2-27B-F16.gguf', quant: 'F16', sizeBytes: 53_800_000_000 },
    { fileName: 'Ternary-Bonsai-2-27B-PTQ1_0.gguf', quant: 'PTQ1_0', sizeBytes: 5_950_000_000 }
  ],
  downloadModel
}

describe('<ModelsScreen/> Hugging Face variant download', () => {
  afterEach(() => { cleanup(); downloadModel.mockClear() })

  it('lets the user choose the 1-bit size from the panel before downloading', async () => {
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)
    await user.type(screen.getByPlaceholderText('Search models…'), 'Bonsai')
    const model = await screen.findByRole('listitem')
    // A search result opens its panel, where the sizes are offered in words.
    await user.click(within(model).getByRole('button', { name: 'Download' }))
    const panel = await screen.findByRole('dialog', { name: /Ternary-Bonsai-2-27B-gguf details/ })
    expect(panel.closest('[data-testid="side-panel-layer"]')).toBeTruthy()
    const sizes = within(panel).getByRole('region', { name: 'Available model files' })
    expect(await within(sizes).findByText('Ternary-Bonsai-2-27B-F16.gguf')).toBeTruthy()
    expect(within(sizes).getByText('Best quality')).toBeTruthy()
    expect(within(sizes).getByText('Smaller')).toBeTruthy()
    await user.click(
      within(sizes).getByRole('button', { name: 'Download Ternary-Bonsai-2-27B-PTQ1_0.gguf' })
    )
    expect(downloadModel).toHaveBeenCalledWith(repo, 'Ternary-Bonsai-2-27B-PTQ1_0.gguf')
  })

  it('shows downloadable files when the model info button opens details', async () => {
    const { ModelsScreen } = await import('../ModelsScreen')
    const user = userEvent.setup()
    render(<ModelsScreen />)

    const card = (await screen.findByText('Qwen3.5-9B-GGUF')).closest('[role="listitem"]') as HTMLElement
    await user.click(within(card).getByRole('button', { name: 'Details' }))
    const details = await screen.findByRole('dialog', { name: 'Qwen3.5-9B-GGUF details' })
    const files = within(details).getByRole('region', { name: 'Available model files' })
    expect(await within(files).findByText('Qwen3.5-9B-Q4_K_M.gguf')).toBeTruthy()
    expect(within(files).getByText('Qwen3.5-9B-Q8_0.gguf')).toBeTruthy()
    await user.click(within(files).getByRole('button', { name: 'Download Qwen3.5-9B-Q4_K_M.gguf' }))
    expect(downloadModel).toHaveBeenCalledWith(catalogRepo, 'Qwen3.5-9B-Q4_K_M.gguf')
  })
})
