// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpgradeScreen } from '../UpgradeScreen'
import { getProFeature, PRO_FEATURES } from '../proCatalog'

const day = getProFeature('day')!

function renderOn(platform: string, variant: 'upgrade' | 'coming-soon' = 'upgrade'): void {
  vi.stubGlobal('__OFFGRID_PRO__', false)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform, openExternal: vi.fn() }
  })
  render(<UpgradeScreen feature={day} variant={variant} />)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Pro platform availability', () => {
  it.each(['darwin', 'win32'])('shows Pro as live on %s', (platform) => {
    renderOn(platform)
    expect(screen.getByText(/Off Grid AI Pro · Available now/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(screen.queryByText(/coming soon to Linux/i)).toBeNull()
  })

  it('shows every Pro feature as coming soon on Linux', () => {
    expect(PRO_FEATURES.every((feature) => !feature.platforms.includes('linux'))).toBe(true)
    renderOn('linux')
    expect(screen.getByText(/Off Grid AI Pro · Coming soon/)).toBeTruthy()
    expect(screen.getByText(/Pro features are coming soon to Linux/)).toBeTruthy()
    expect(screen.getByText(/Core features work on Linux now/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull()
  })

  it('gives an existing Linux subscriber the same status', () => {
    renderOn('linux', 'coming-soon')
    expect(screen.getByText(/Pro features are coming soon to Linux/)).toBeTruthy()
    expect(screen.getByText(/Core features work on your device today/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull()
  })
})
