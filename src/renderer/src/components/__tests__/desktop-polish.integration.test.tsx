// @vitest-environment jsdom
//
// RELEASE_TEST_CHECKLIST #149 and #152 - large collection and transient-layer
// integration coverage. The production Models screen and shared modal are real;
// only Electron/native calls are provided at the window.api boundary.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal, ModalBody, ModalContent, ModalTrigger } from '../ui/animated-modal'

// The catalog count is an animated number beside the word "models", so the visible phrase
// spans two elements. Match the element that reads exactly that phrase.
const modelCount =
  (count: number) =>
  (_content: string, element: Element | null): boolean =>
    element?.tagName === 'SPAN' && element.textContent === `${count} models`
// The number springs from its previous value to the new one with the library's real
// AnimatedNumber, which can take longer than Testing Library's 1s default to settle.
const findModelCount = (count: number): Promise<HTMLElement> =>
  screen.findByText(modelCount(count), undefined, { timeout: 5_000 })

let ModelsScreen: typeof import('../ModelsScreen').ModelsScreen

const MODELS = Array.from({ length: 120 }, (_, index) => ({
  id: `community/model-${String(index + 1).padStart(3, '0')}`,
  name: `Seeded Model ${String(index + 1).padStart(3, '0')}`,
  kind: index % 12 === 0 ? 'vision' : 'text',
  org: 'community',
  description: `Synthetic catalog entry ${index + 1}`,
  params: (index % 10) + 1,
  files: [{ name: 'model.gguf', url: 'https://example.test/model.gguf', sizeBytes: 1e9 }]
}))

function installBoundary(): void {
  const values: Record<string, unknown> = {
    systemHealth: async () => ({ ramGb: 16 }),
    getModelCatalog: async () => ({ kinds: ['text', 'image'], models: MODELS }),
    getInstalledModels: async () => [],
    getActiveModelIds: async () => [],
    onModelProgress: () => () => {}
  }
  const api = new Proxy(values, {
    get(target, property: string) {
      if (property in target) return target[property]
      return async () => undefined
    }
  })
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
}

function SharedModalHarness(): React.JSX.Element {
  return (
    <div>
      <p>Underlying workspace remains selected</p>
      <Modal>
        <ModalTrigger>Open details modal</ModalTrigger>
        <ModalBody>
          <ModalContent>
            <h2>Transient details</h2>
            <Modal>
              <ModalTrigger>Open nested confirmation</ModalTrigger>
              <ModalBody>
                <ModalContent>
                  <h3>Nested confirmation</h3>
                </ModalContent>
              </ModalBody>
            </Modal>
          </ModalContent>
        </ModalBody>
      </Modal>
    </div>
  )
}

describe('desktop collection and transient-layer integration', () => {
  beforeAll(async () => {
    installBoundary()
    ;({ ModelsScreen } = await import('../ModelsScreen'))
  }, 30_000)

  beforeEach(() => {
    vi.clearAllMocks()
    installBoundary()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps a large synthetic model catalog filterable and its detail panel usable (#149)', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    expect(await findModelCount(120)).not.toBeNull()
    expect(await screen.findByRole('button', { name: 'Seeded Model 120' })).not.toBeNull()

    await user.click(screen.getByRole('radio', { name: 'Coding' }))
    expect(await findModelCount(84)).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Seeded Model 001' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Seeded Model 120' }))
    const heading = await screen.findByRole('heading', { name: 'Seeded Model 120' })
    // The card shows the description too; the detail panel is the one under test.
    const panel = heading.closest('[role="dialog"]') as HTMLElement
    expect(within(panel).getByText('Synthetic catalog entry 120')).not.toBeNull()
  })

  it('Escape closes only the model detail layer and preserves the filtered collection (#152)', async () => {
    const user = userEvent.setup()
    render(<ModelsScreen />)

    await user.click(await screen.findByRole('radio', { name: 'Coding' }))
    await user.click(await screen.findByRole('button', { name: 'Seeded Model 120' }))
    expect(await screen.findByRole('heading', { name: 'Seeded Model 120' })).not.toBeNull()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Seeded Model 120' })).toBeNull()
    })
    expect(await findModelCount(84)).not.toBeNull()
    expect(screen.getByRole('radio', { name: 'Coding' })).not.toBeNull()
  })

  it('Escape closes only the top shared modal and restores focus without clearing state (#152)', async () => {
    const user = userEvent.setup()
    render(<SharedModalHarness />)

    const trigger = screen.getByRole('button', { name: 'Open details modal' })
    await user.click(trigger)
    expect(await screen.findByRole('heading', { name: 'Transient details' })).not.toBeNull()

    const nestedTrigger = screen.getByRole('button', { name: 'Open nested confirmation' })
    await user.click(nestedTrigger)
    expect(await screen.findByRole('heading', { name: 'Nested confirmation' })).not.toBeNull()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Nested confirmation' })).toBeNull()
    })
    expect(screen.getByRole('heading', { name: 'Transient details' })).not.toBeNull()
    expect(document.activeElement).toBe(nestedTrigger)

    await user.keyboard('{Escape}')
    await waitFor(
      () => {
        expect(screen.queryByRole('heading', { name: 'Transient details' })).toBeNull()
      },
      // AnimatePresence keeps the closing layer mounted until the real spring exit
      // finishes. Under full-suite load that can exceed Testing Library's 1s default.
      { timeout: 5_000 }
    )
    expect(screen.getByText('Underlying workspace remains selected')).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
