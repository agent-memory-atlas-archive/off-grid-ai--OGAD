/**
 * E2E: the Settings screen's sections and the resource-mode selector.
 *
 * This covers the surface that had NO passing e2e: tour.spec.ts asserted the sections render
 * but died on its second section click (single-open accordion), so nothing past that ran.
 *
 * Section coverage here is enumerated from the DOM rather than a hardcoded list, so a newly
 * added Settings section is covered the moment it ships instead of needing a new test.
 *
 * Fresh temp profile, OFFGRID_PRO=0 (deterministic free-tier UI), synthetic data only.
 */
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { launchOffGrid } from './helpers/launch'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { gotoSettings, openSettingsSection, closeSettingsSection } from './helpers/settings'
import { completeOnboarding } from './helpers/onboarding'

let app: ElectronApplication | null = null
let page: Page
let userDataDir: string

const launchApp = async (): Promise<void> => {
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: userDataDir,
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
}

const closeApp = async (): Promise<void> => {
  const running = app
  if (!running) return
  app = null
  const child = running.process()
  await running.close()
  if (child.exitCode === null) {
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  }
}

// A section's accordion header: the only buttons on this screen that own an <h3> title.
const sectionHeaders = (): Locator => page.locator('button[aria-expanded]:has(h3)')

/** The card element wrapping a header (its parent), so we can read the whole card's text. */
const cardFor = (header: Locator): Locator => header.locator('xpath=..')

const performanceMode = async (): Promise<string | undefined> =>
  page.evaluate(async () => {
    const settings = (await window.api.getLlmSettings()) as { performanceMode?: string } | undefined
    return settings?.performanceMode
  })

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-settings-sections-e2e-'))
  await launchApp()
})

test.afterEach(async () => {
  await closeApp()
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

test('every Settings section opens as a detail and renders a non-empty body', async () => {
  await gotoSettings(page)

  // Enumerate while everything is collapsed — opening one section hides its siblings.
  const titles = await sectionHeaders().locator('h3').allInnerTexts()
  // A floor of sections core always ships, so a broken enumeration cannot pass vacuously by
  // finding one card (or none). Anything beyond these is still covered by the loop below.
  expect(titles).toEqual(
    expect.arrayContaining(['Setup & health', 'Capture & processing', 'Data & privacy'])
  )

  for (const title of titles) {
    await openSettingsSection(page, title)

    const open = page.locator('button[aria-expanded="true"]:has(h3)')
    await expect(open).toHaveCount(1)
    // Only the open card in a group renders the "All settings" back affordance.
    await expect(open).toContainText('All settings')

    // The body actually rendered: the card holds substantially more than its own title.
    const card = cardFor(open)
    const body = (await card.innerText()).trim()
    expect(body.length, `section "${title}" opened but rendered no body`).toBeGreaterThan(
      title.length + 20
    )
  }

  // Collapsing returns to the grid with every section visible again.
  await closeSettingsSection(page)
  await expect(sectionHeaders()).toHaveCount(titles.length)
})

test('resource mode selection is exclusive and persists to llm settings', async () => {
  await gotoSettings(page)
  await openSettingsSection(page, 'Setup & health')

  for (const label of ['Conservative', 'Extreme', 'Balanced']) {
    const mode = page.getByRole('radio', { name: label }).first()
    await mode.click()
    await expect(mode).toHaveAttribute('aria-checked', 'true')

    // Exactly one mode is ever pressed.
    const pressed = page.locator('[role="radio"][aria-checked="true"]').filter({
      hasText: /^(Conservative|Balanced|Extreme)$/
    })
    await expect(pressed).toHaveCount(1)

    // And the choice reached the main process, not just React state.
    await expect.poll(performanceMode).toBe(label.toLowerCase())
  }
})

test('resource mode survives a relaunch', async () => {
  await gotoSettings(page)
  await openSettingsSection(page, 'Setup & health')
  await page.getByRole('radio', { name: 'Conservative' }).first().click()
  await expect.poll(performanceMode).toBe('conservative')

  await closeApp()
  await launchApp()
  await gotoSettings(page)
  await openSettingsSection(page, 'Setup & health')

  await expect(page.getByRole('radio', { name: 'Conservative' }).first()).toHaveAttribute(
    'aria-checked',
    'true'
  )
  expect(await performanceMode()).toBe('conservative')
})
