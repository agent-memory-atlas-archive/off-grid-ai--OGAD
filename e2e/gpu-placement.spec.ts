/**
 * GPU placement in the model settings drawer.
 *
 * Real app; the only boundary is a fake llama-server that records its launch arguments and
 * reports the layers it placed on the GPU, as llama.cpp does while it loads. Auto is the default:
 * the engine starts with no layer count and the drawer shows what it placed. Turning Auto off
 * brings back the layer slider and relaunches with the person's count.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { closeAndWait, mainWindow } from './helpers/windows'

const ANSWER = 'The local engine answered.'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string

const launches = (): string[][] =>
  fs.existsSync(modelLog)
    ? fs
        .readFileSync(modelLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { event: string; args?: string[] })
        .filter((entry) => entry.event === 'launch')
        .map((entry) => entry.args ?? [])
    : []

const installModelBoundary = (): void => {
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
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/placement-llama-server.mjs'), executable)
  fs.chmodSync(executable, 0o755)
}

test.describe('GPU placement', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-gpu-placement-'))
    modelLog = path.join(profileDir, 'model-log.jsonl')
    installModelBoundary()
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
        OFFGRID_LLAMA_LAUNCH_LOG: modelLog,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    if (app) await closeAndWait(app)
    app = null
    if (fs.existsSync(modelLog)) fs.copyFileSync(modelLog, testInfo.outputPath('model-log.jsonl'))
    fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('Auto leaves placement to the engine and shows what it placed; Manual passes the layer count', async () => {
    test.setTimeout(120_000)
    // The model loads on first use: a chat starts the engine.
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    const composer = page.getByRole('textbox', { name: 'Message', exact: true })
    await composer.fill('Are you there?')
    await composer.press('Enter')
    await expect(page.getByText(ANSWER).first()).toBeVisible({ timeout: 60_000 })
    expect(launches().at(-1)).not.toContain('-ngl')

    // The chat header's Settings opens the model settings drawer.
    await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
    const drawer = page.getByLabel('Model settings')
    await expect(drawer).toBeVisible()
    const performance = drawer.getByRole('button', { name: /^Performance/ })
    if ((await performance.getAttribute('aria-expanded')) !== 'true') await performance.click()

    const auto = drawer.getByRole('switch', { name: 'Place GPU layers automatically' })
    await expect(auto).toHaveAttribute('aria-checked', 'true')
    await expect(drawer.getByLabel('GPU layers in use')).toHaveText('49/49')
    await auto.scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'e2e/screenshots/gpu-placement-auto.png' })

    const before = launches().length
    await auto.click()

    await expect(auto).toHaveAttribute('aria-checked', 'false')
    await expect(drawer.getByRole('slider', { name: 'GPU layers' })).toBeVisible()
    await expect
      .poll(() => launches().slice(before).at(-1)?.join(' ') ?? '', { timeout: 30_000 })
      .toContain('-ngl 99')
    await page.screenshot({ path: 'e2e/screenshots/gpu-placement-manual.png' })
  })
})
