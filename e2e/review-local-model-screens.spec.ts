// Review capture, opt-in: screenshots of every screen OGAD #206 changes. It runs only when
// REVIEW_OUT names the folder to write them to, so the default e2e suite never pays for it.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid } from './helpers/launch'
import { closeAndWait, mainWindow } from './helpers/windows'

const OUT = process.env.REVIEW_OUT ?? ''
test.skip(!OUT, 'Review capture: set REVIEW_OUT to a folder to run it.')
let app: ElectronApplication | null = null
let page: Page
let profileDir: string

const shot = async (name: string): Promise<void> => {
  await page.waitForTimeout(900)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
}

const openTab = async (name: string): Promise<boolean> => {
  const el = page.getByRole('radiogroup', { name: 'Model types' }).getByRole('radio', { name: new RegExp(`^${name}`, 'i') })
  if (!(await el.isVisible().catch(() => false))) return false
  await el.click()
  return true
}

test.describe.configure({ timeout: 300_000 })

test.beforeEach(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-review-'))
  app = await launchOffGrid({
    env: { ...process.env, OFFGRID_USER_DATA: profileDir, OFFGRID_PRO: '0', NODE_ENV: 'production' }
  })
  page = await mainWindow(app)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await completeOnboarding(page)
})

test.afterEach(async () => {
  if (app) await closeAndWait(app)
  app = null
  fs.rmSync(profileDir, { recursive: true, force: true })
})

test('Models screen, every tab and state', async () => {
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await expect(page.getByRole('list', { name: /^Picks for this / })).toBeVisible({ timeout: 60_000 })
  await shot('01-models-text')

  // A capability icon's tooltip.
  const icon = page.getByRole('list', { name: /^Picks for this / }).locator('[aria-label][title]').first()
  if (await icon.isVisible().catch(() => false)) {
    await icon.hover()
    await shot('02-models-capability-tooltip')
  }

  const more = page.getByRole('button', { name: /^Show \d+ more, too big/ })
  if (await more.isVisible().catch(() => false)) {
    await more.scrollIntoViewIfNeeded()
    await more.click()
    await shot('03-models-too-big-shown')
    await page.mouse.wheel(0, -5000)
  }

  // A model's detail panel: fit verdict and files.
  const firstCard = page.getByRole('list', { name: /^Picks for this / }).getByRole('listitem').first()
  const nameButton = firstCard.getByRole('button').first()
  await nameButton.click()
  await shot('04-models-detail')
  const close = page.getByRole('button', { name: 'Close', exact: true }).last()
  if (await close.isVisible().catch(() => false)) await close.click()

  const search = page.getByPlaceholder('Search models…')
  await search.fill('qwen')
  await page.waitForTimeout(2500)
  await shot('05-models-search')
  await search.fill('qwen3.6')
  await page.waitForTimeout(3500)
  await shot('05b-models-search-moe')
  await search.fill('minicpm')
  await page.waitForTimeout(3500)
  await shot('05c-models-search-minicpm')
  await search.fill('')

  for (const [tab, file] of [
    ['Image', '06-models-image'],
    ['Tasks', '07-models-tasks'],
    ['Voice', '08-models-voice'],
    ['Transcription', '09-models-transcription']
  ] as const) {
    if (await openTab(tab)) await shot(file)
  }

  // The composer's model picker shares the capability icons.
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  await shot('10-chat-empty')
})

test('GPU placement, settled', async () => {
  // Same boundary as gpu-placement.spec.ts: a fake llama-server that reports placed layers.
  if (app) await closeAndWait(app)
  const modelsDir = path.join(profileDir, 'models')
  const llamaDir = path.join(profileDir, 'bin', 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'gpu-placement.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'gpu-placement-model', primary: 'gpu-placement.gguf', mmproj: null })
  )
  const exe = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/placement-llama-server.mjs'), exe)
  fs.chmodSync(exe, 0o755)
  app = await launchOffGrid({
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profileDir,
      OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
      OFFGRID_LLAMA_LAUNCH_LOG: path.join(profileDir, 'log.jsonl'),
      OFFGRID_PRO: '0',
      NODE_ENV: 'production',
      NO_PROXY: '127.0.0.1,localhost'
    }
  })
  page = await mainWindow(app)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'Chat', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await composer.fill('Are you there?')
  await composer.press('Enter')
  await expect(page.getByText('The local engine answered.').first()).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
  const drawer = page.getByLabel('Model settings')
  await expect(drawer).toBeVisible()
  await shot('11-model-settings-top')
  const performance = drawer.getByRole('button', { name: /^Performance/ })
  if ((await performance.getAttribute('aria-expanded')) !== 'true') await performance.click()
  const auto = drawer.getByRole('switch', { name: 'Place GPU layers automatically' })
  await expect(drawer.getByLabel('GPU layers in use')).toHaveText('49/49')
  await auto.scrollIntoViewIfNeeded()
  await page.waitForTimeout(1500)
  await shot('12-gpu-layers-auto')
  await auto.click()
  await expect(drawer.getByRole('slider', { name: 'GPU layers' })).toBeVisible()
  await page.waitForTimeout(1500)
  await shot('13-gpu-layers-manual')
})
