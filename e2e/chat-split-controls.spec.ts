/**
 * Chat's split view: the controls (back to one chat, pane count, send to all) sit in the top-right
 * pane and stay at the window's top-right corner while panes are added, instead of jumping with the
 * first pane as the grid changes from two to three columns and back. Every pane can pick its own
 * model, gallery and tasks; the app-wide Active models and Settings show once. Real app; nothing
 * faked.
 */
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'
import { closeAndWait, gotoScreen, mainWindow } from './helpers/windows'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string

test.beforeEach(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-split-controls-'))
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_PRO: '0',
      NODE_ENV: 'production'
    }
  })
  page = await mainWindow(app)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await completeOnboarding(page)
})

test.afterEach(async () => {
  if (app) await closeAndWait(app)
  app = null
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
})

/** Where a control sits, measured from the window's top-right corner. */
async function fromTopRight(control: Locator): Promise<{ right: number; top: number }> {
  const box = await control.boundingBox()
  const width = await page.evaluate(() => window.innerWidth)
  if (!box) throw new Error('control is not on screen')
  return { right: Math.round(width - (box.x + box.width)), top: Math.round(box.y) }
}

test('split controls stay in the top-right corner as panes are added', async () => {
  test.setTimeout(3 * 60_000)
  await gotoScreen(page, 'Chat')
  await page.getByRole('button', { name: 'Open tabs side by side' }).click()

  // A fresh chat with no open tabs still splits into two panes.
  await expect(page.locator('[data-chat-pane]')).toHaveCount(2)
  const addPane = page.getByRole('button', { name: 'Add a pane' })
  await expect(addPane).toHaveCount(1)
  // One set of controls for the whole split view, not one per pane.
  await expect(page.getByRole('button', { name: 'One chat' })).toHaveCount(1)
  const atTwo = await fromTopRight(addPane)

  for (const panes of [3, 4, 5]) {
    await addPane.click()
    await expect(page.locator('[data-chat-pane]')).toHaveCount(panes)
    expect(await fromTopRight(addPane)).toEqual(atTwo)
  }
  await page.screenshot({ path: 'e2e/screenshots/chat-split-controls.png' })

  // Each pane has its own model picker, gallery and tasks (they follow the pane's chat). The
  // app-wide Active models and Settings show once, with the split controls.
  const panes = page.locator('[data-chat-pane]')
  await expect(page.getByRole('combobox', { name: 'Model for this pane' })).toHaveCount(5)
  await expect(panes.getByRole('button', { name: 'Gallery' })).toHaveCount(5)
  await expect(panes.getByRole('button', { name: /^Tasks/ })).toHaveCount(5)
  await expect(panes.getByRole('button', { name: 'Active models' })).toHaveCount(1)
  await expect(panes.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1)

  await page.getByRole('button', { name: 'One chat' }).click()
  await expect(page.locator('[data-chat-pane]')).toHaveCount(0)
})
