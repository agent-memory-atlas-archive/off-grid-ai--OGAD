// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpgradeScreen } from '../UpgradeScreen'
import { getProFeature, PRO_FEATURES } from '../proCatalog'

const day = getProFeature('day')!

function renderOn(
  platform: string,
  variant: 'upgrade' | 'coming-soon' = 'upgrade',
  feature = day,
  proBuild = false
): void {
  vi.stubGlobal('__OFFGRID_PRO__', proBuild)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform, openExternal: vi.fn() }
  })
  render(<UpgradeScreen feature={feature} variant={variant} />)
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

  it('keeps other Pro features gated on Linux', () => {
    expect(
      PRO_FEATURES.filter((feature) => feature.platforms.includes('linux')).map(
        (feature) => feature.route
      )
    ).toEqual(['vault'])
    renderOn('linux')
    expect(screen.getByText(/Off Grid AI Pro · Coming soon/)).toBeTruthy()
    expect(screen.getByText(/This feature is coming soon to Linux/)).toBeTruthy()
    expect(screen.getByText(/Vault is available on Linux now/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull()
  })

  it('gives an existing Linux subscriber the same status', () => {
    renderOn('linux', 'coming-soon')
    expect(screen.getByText(/This feature is coming soon to Linux/)).toBeTruthy()
    expect(screen.getByText(/Core features work on your device today/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Get Pro/ })).toBeNull()
  })

  it('offers Vault and license activation on Linux', () => {
    renderOn('linux', 'upgrade', getProFeature('vault')!, true)
    expect(screen.getByText(/Off Grid AI Pro · Available now/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Activate/ })).toBeTruthy()
    expect(screen.queryByText(/coming soon to Linux/i)).toBeNull()
  })

  it('offers purchase and license activation on the general Linux upgrade screen', () => {
    vi.stubGlobal('__OFFGRID_PRO__', true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { platform: 'linux', openExternal: vi.fn() }
    })
    render(<UpgradeScreen />)

    expect(screen.getByText(/Some Pro features are coming soon to Linux/)).toBeTruthy()
    expect(screen.getByText(/Vault is available on Linux now/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Get Pro/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Activate/ })).toBeTruthy()
  })
})
