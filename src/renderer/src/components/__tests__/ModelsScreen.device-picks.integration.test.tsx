// @vitest-environment jsdom

// Integration: the Text tab leads with Fast, Balanced and Best for this machine, chosen by the shared
// rule from the models that fit with room. Real ModelsScreen and real @offgrid/models; only
// window.api, the IPC line out of the renderer, is faked.
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'

const model = (id: string, name: string, params: number, gb: number): Record<string, unknown> => ({
  id,
  name,
  kind: 'text',
  org: 'Acme',
  params,
  description: `${name} for everyday chat`,
  files: [{ name: `${id}.gguf`, sizeBytes: gb * 1e9 }]
})
const image = (id: string, name: string, gb: number): Record<string, unknown> => ({
  id,
  name,
  kind: 'image',
  org: 'Acme',
  files: [{ name: `${id}.gguf`, sizeBytes: gb * 1e9 }]
})
const IMAGE_MODELS = [
  image('acme/sd-turbo', 'SD Turbo', 2.5),
  image('acme/sdxl', 'SDXL', 6.9),
  image('acme/flux', 'Flux Schnell', 9)
]
const MODELS = [
  model('acme/tiny', 'Tiny 0.8B', 0.8, 0.7),
  model('acme/two', 'Two 2B', 2, 1.9),
  model('acme/four', 'Four 4B', 4, 3.8),
  model('acme/nine', 'Nine 9B', 9, 5.9),
  model('acme/big', 'Big 27B', 27, 18)
]

let ramGb = 16
;(window as unknown as { api: unknown }).api = {
  systemHealth: async () => ({ ramGb }),
  getModelCatalog: async () => ({ kinds: ['text', 'image'], models: [...MODELS, ...IMAGE_MODELS] }),
  getInstalledModels: async () => [],
  getActiveModelIds: async () => [],
  getModelVisionStatus: async () => ({}),
  onModelProgress: () => () => {},
  searchModels: async () => []
}

const waitForPicks = async (): Promise<string[]> => {
  await screen.findByText('Flux Schnell')
  return pickNames()
}

const pickNames = (): string[] =>
  within(screen.getByRole('list', { name: /^Picks for this / }))
    .getAllByRole('listitem')
    .map((card) => card.textContent ?? '')

describe('<ModelsScreen/> picks for this device', () => {
  afterEach(() => cleanup())

  it('leads with Fast, Balanced and Best that fit with room, each shown once', async () => {
    ramGb = 16
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByRole('list', { name: /^Picks for this / })
    const [fast, balanced, best] = pickNames()
    expect(fast).toContain('Two 2B')
    expect(fast).toContain('Fast')
    expect(balanced).toContain('Four 4B')
    expect(balanced).toContain('Balanced')
    expect(best).toContain('Nine 9B')
    expect(best).toContain('Best')
    // The card says what the model is for.
    expect(best).toContain('Nine 9B for everyday chat')
    // A pick is not repeated in the list below.
    const available = screen.getByRole('list', { name: 'Models available to download' })
    expect(within(available).queryByText('Nine 9B')).toBeNull()
    expect(within(available).getByText('Tiny 0.8B')).toBeTruthy()
  })

  it('steps aside once a filter says what the person wants', async () => {
    ramGb = 16
    const user = userEvent.setup()
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByRole('list', { name: /^Picks for this / })
    await user.click(screen.getByRole('radio', { name: '≤4GB' }))
    expect(screen.queryByRole('list', { name: /^Picks for this / })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await screen.findByRole('list', { name: /^Picks for this / })).toBeTruthy()
  })

  it('shows no picks on a machine where nothing fits with room', async () => {
    ramGb = 1
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByText('Tiny 0.8B')
    expect(screen.queryByRole('list', { name: /^Picks for this / })).toBeNull()
  })

  it('leads the Image tab with its own picks too, from the same rule', async () => {
    ramGb = 24
    const user = userEvent.setup()
    const { ModelsScreen } = await import('../ModelsScreen')
    render(<ModelsScreen />)

    await screen.findByRole('list', { name: /^Picks for this / })
    await user.click(screen.getByRole('radio', { name: 'Image' }))
    const [fast, balanced, best] = await waitForPicks()
    expect(fast).toContain('SD Turbo')
    expect(balanced).toContain('SDXL')
    expect(best).toContain('Flux Schnell')
  })
})
