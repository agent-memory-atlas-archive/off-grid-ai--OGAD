// @vitest-environment jsdom
// A newer llama.cpp installs while the gateway keeps several models loaded. Nothing restarts on its
// own (that would cut off answers in flight): a card offers the restart, as an app update does.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installAppBoundary,
  installAppBrowserBoundary,
  installAppStorage
} from './harness/app-boundary'

let App: typeof import('../App').default
let engineInstalled: (() => void) | null = null
let restarts = 0

describe('<App/> kept-model engine update', () => {
  beforeAll(async () => {
    installAppBoundary({
      keepLoadedEngineUpdateReady: async () => false,
      onKeepLoadedEngineUpdate: (callback: () => void) => {
        engineInstalled = callback
        return () => {
          engineInstalled = null
        }
      },
      restartKeepLoadedModels: async () => {
        restarts += 1
        return {}
      }
    })
    installAppBrowserBoundary()
    ;({ default: App } = await import('../App'))
  }, 30_000)

  beforeEach(() => {
    installAppStorage().setItem('onboarding_completed', 'true')
    window.history.replaceState(null, '', '/models')
    installAppBrowserBoundary()
    restarts = 0
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('offers the restart when a newer engine installs, and restarts only when asked', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('navigation', { name: 'Primary navigation' })
    expect(screen.queryByText('Engine update ready for kept models')).toBeNull()

    await waitFor(() => expect(engineInstalled).not.toBeNull())
    act(() => engineInstalled?.())
    expect(await screen.findByText('Engine update ready for kept models')).toBeTruthy()
    expect(restarts).toBe(0)

    await user.click(screen.getByRole('button', { name: 'Restart models' }))
    await waitFor(() =>
      expect(screen.queryByText('Engine update ready for kept models')).toBeNull()
    )
    expect(restarts).toBe(1)
  }, 30_000)
})
