/**
 * Settings → Text → Answers → Project knowledge: "Relevant passages" adds only the best
 * knowledge-base passages for the question, instead of every document.
 *
 * Real app, real document engine and ranking (with the installed local embedding model); the
 * only boundaries are the OS file picker and a fake llama-server that records every request.
 * A project holds twelve small documents. With the default, "Every answer", a question puts all
 * twelve into the prompt. With "Relevant passages", the same question in a new chat puts in the
 * document it is about, and no more than the eight best passages.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'

const PROJECT = 'Lighthouse archive'
const STATIONS = [
  'quokka',
  'heron',
  'walrus',
  'otter',
  'puffin',
  'gannet',
  'plover',
  'curlew',
  'tern',
  'osprey',
  'kittiwake',
  'cormorant'
]
const codeword = (station: string): string => `${station.toUpperCase()}-${station.length * 7}`
const QUESTION = 'What is the keeper codeword for the quokka station?'

let app: ElectronApplication | null = null
let page: Page
let rootDir: string
let profileDir: string
let modelLog: string

async function closeApp(): Promise<void> {
  const running = app
  if (!running) return
  app = null
  const child: ChildProcess = running.process()
  await running.close()
  if (child.exitCode === null)
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

function installModelBoundary(): string {
  const modelsDir = path.join(profileDir, 'models')
  const binDir = path.join(profileDir, 'e2e-bin')
  const llamaDir = path.join(binDir, 'llama')
  fs.mkdirSync(modelsDir, { recursive: true })
  fs.mkdirSync(llamaDir, { recursive: true })
  const model = Buffer.alloc(2_048)
  model.write('GGUF')
  fs.writeFileSync(path.join(modelsDir, 'relevant-passages.gguf'), model)
  fs.writeFileSync(
    path.join(modelsDir, 'active-model.json'),
    JSON.stringify({ id: 'relevant-passages', primary: 'relevant-passages.gguf', mmproj: null })
  )
  const embeddingCache = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Off Grid AI Desktop',
    'models',
    '.cache',
    'Xenova'
  )
  if (!fs.existsSync(embeddingCache)) {
    throw new Error(`This spec requires the installed local embedding cache at ${embeddingCache}`)
  }
  fs.mkdirSync(path.join(modelsDir, '.cache'), { recursive: true })
  fs.symlinkSync(embeddingCache, path.join(modelsDir, '.cache', 'Xenova'), 'dir')
  // Records every request it receives (OFFGRID_APP143_MODEL_LOG) and answers plainly.
  const executable = path.join(llamaDir, 'llama-server')
  fs.copyFileSync(path.resolve('e2e/fixtures/app143-approval-llama-server.mjs'), executable)
  fs.chmodSync(executable, 0o755)
  return binDir
}

/** The codewords that reached the model in the request carrying this turn's question. */
async function codewordsSentFor(chatNumber: number): Promise<string[]> {
  let sent: string[] = []
  await expect
    .poll(
      () => {
        if (!fs.existsSync(modelLog)) return 0
        // Chat turns only: a follow-up suggestion request also quotes the question.
        const turns = fs
          .readFileSync(modelLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .filter((line) => {
            const request = JSON.parse(line) as { messages?: { role: string; content: unknown }[] }
            const users = (request.messages ?? []).filter((message) => message.role === 'user')
            const last = JSON.stringify(users[users.length - 1]?.content ?? '')
            return last.includes(QUESTION) && !last.includes('The user asked:')
          })
        const turn = turns[chatNumber - 1]
        if (!turn) return 0
        sent = STATIONS.map(codeword).filter((word) => turn.includes(word))
        return turns.length
      },
      { timeout: 60_000 }
    )
    .toBeGreaterThanOrEqual(chatNumber)
  return sent
}

async function openProject(): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('button', { name: 'Projects', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
}

async function askInNewProjectChat(): Promise<void> {
  await openProject()
  await page.getByText(PROJECT, { exact: true }).first().click()
  await page.getByRole('radio', { name: 'Chats', exact: true }).click()
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await expect(composer).toHaveAttribute('placeholder', /Ask about/i)
  await composer.fill(QUESTION)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Stop generating', exact: true })).toBeHidden({
    timeout: 60_000
  })
}

test.describe('Project knowledge: relevant passages', () => {
  test.skip(targetIsPackaged(), 'This native-boundary fixture is for the source-built E2E target.')
  test.describe.configure({ timeout: 240_000 })

  test.beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-relevant-passages-'))
    profileDir = path.join(rootDir, 'profile')
    modelLog = path.join(profileDir, 'model-requests.jsonl')
    const binDir = installModelBoundary()
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: binDir,
        OFFGRID_APP143_MODEL_LOG: modelLog,
        OFFGRID_PRO: '0',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await completeOnboarding(page)
  })

  test.afterEach(async () => {
    if (fs.existsSync(modelLog))
      await test.info().attach('model-requests.jsonl', { path: modelLog })
    await closeApp()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  test('Relevant passages sends the matching document, not the whole knowledge base', async () => {
    // A project with twelve documents, one per station.
    await openProject()
    await page.getByTitle('New project').click()
    await page.getByPlaceholder('Project name…').fill(PROJECT)
    await page.keyboard.press('Enter')
    await expect(
      page.getByRole('radio', { name: 'Knowledge & settings', exact: true })
    ).toBeVisible()
    const files = STATIONS.map((station) => {
      const file = path.join(rootDir, `${station}-station.txt`)
      fs.writeFileSync(
        file,
        `Station log for the ${station} lighthouse.\nThe keeper codeword for the ${station} station is ${codeword(station)}.\n`
      )
      return file
    })
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: selected })
    }, files)
    await page.getByRole('button', { name: 'Add files', exact: true }).click()
    for (const station of STATIONS) {
      await expect(page.getByText(`${station}-station.txt`, { exact: true })).toHaveCount(1, {
        timeout: 60_000
      })
    }
    await expect(page.getByRole('progressbar', { name: /^Indexing / })).toHaveCount(0, {
      timeout: 120_000
    })

    // Every answer (the default) reads the whole knowledge base: all twelve documents go in.
    await askInNewProjectChat()
    expect(await codewordsSentFor(1)).toHaveLength(STATIONS.length)

    // Settings → Text → Answers → Project knowledge → Relevant passages.
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByRole('button', { name: 'Active models' }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
    const mode = page.getByRole('radiogroup', { name: 'Project knowledge' })
    await expect(mode.getByRole('radio', { name: 'Every answer' })).toBeChecked()
    await mode.getByRole('radio', { name: 'Relevant passages' }).click()
    await expect(mode.getByRole('radio', { name: 'Relevant passages' })).toBeChecked()
    await page.keyboard.press('Escape')

    // The same question in a new chat: the quokka document goes in, and only the best passages.
    await askInNewProjectChat()
    const relevant = await codewordsSentFor(2)
    expect(relevant).toContain(codeword('quokka'))
    expect(relevant.length).toBeLessThanOrEqual(8)
  })
})
