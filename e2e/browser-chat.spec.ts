/**
 * A chat started in the paired browser runs on Desktop and shows up there.
 *
 * Real app and real bridge; the boundaries are the fake paired browser and a fake llama-server
 * that records every request. The browser starts a chat, renames it, retries its first answer
 * (which keeps the original chat and makes a branch), and stops a run midway.
 *
 * Asserts: the chat appears in Desktop's chat list with Desktop's answer, which also streams back
 * to the browser; the rename shows in Desktop; the retry leaves the original intact beside the
 * branch; a stopped run saves its partial answer once, with no repeated question; and a tool
 * switched off in Desktop is not offered to the model for a browser chat.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { completeOnboarding } from './helpers/onboarding'
import { launchOffGrid, targetIsPackaged } from './helpers/launch'
import { enginePortsUnavailableReason } from './helpers/ports'
import { pairedBrowser, type FakeExtension } from './helpers/fake-extension'
import { closeAndWait, mainWindow } from './helpers/windows'

const PRO_PRESENT = fs.existsSync(path.resolve('pro/package.json'))
const FIRST = 'Plan a picnic by the river'

let app: ElectronApplication | null = null
let page: Page
let profileDir: string
let modelLog: string
let browser: FakeExtension | null = null

interface ChatEvent {
  type: string
  content?: string
  message?: string
}

const id = (): string => randomUUID().replace(/-/g, '')

/** Read a run until it is done; returns its events and the conversation it ran in. */
const readRun = async (
  runId: string,
  until: (events: ChatEvent[]) => boolean = () => false
): Promise<{ events: ChatEvent[]; conversationId: string; done: boolean }> => {
  const events: ChatEvent[] = []
  let cursor = 0
  let conversationId = ''
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const reply = await browser!.rpc('chat.read', { runId, cursor })
    const read = reply.result as {
      events: ChatEvent[]
      cursor: number
      done: boolean
      conversationId: string
    }
    events.push(...read.events)
    cursor = read.cursor
    conversationId = read.conversationId
    if (read.done || until(events)) return { events, conversationId, done: read.done }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not finish: ${JSON.stringify(events.slice(-5))}`)
}

const text = (events: ChatEvent[]): string =>
  events
    .filter((event) => event.type === 'delta')
    .map((event) => event.content ?? '')
    .join('')

/** Tool names offered in the model request that answered `question`. */
const toolsOfferedFor = (question: string): string[][] =>
  (fs.existsSync(modelLog) ? fs.readFileSync(modelLog, 'utf8').split('\n') : [])
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          messages?: { role: string; content: unknown }[]
          tools?: { function: { name: string } }[]
        }
    )
    .filter((body) => {
      const users = (body.messages ?? []).filter((message) => message.role === 'user')
      const last = JSON.stringify(users[users.length - 1]?.content ?? '')
      return last.includes(question) && !last.includes('The user asked:')
    })
    .map((body) => (body.tools ?? []).map((tool) => tool.function.name))

test.describe('Paired-browser chat', () => {
  test.skip(targetIsPackaged(), 'This native-model boundary is for the source-built E2E target.')

  test.beforeEach(async () => {
    test.skip(!PRO_PRESENT, 'pro package not present: browser chats are a Pro surface')
    const busy = await enginePortsUnavailableReason()
    test.skip(busy !== null, busy ?? '')
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-browser-chat-'))
    modelLog = path.join(profileDir, 'model-requests.jsonl')
    const modelsDir = path.join(profileDir, 'models')
    const llamaDir = path.join(profileDir, 'bin', 'llama')
    fs.mkdirSync(modelsDir, { recursive: true })
    fs.mkdirSync(llamaDir, { recursive: true })
    const gguf = Buffer.alloc(2_048)
    gguf.write('GGUF')
    fs.writeFileSync(path.join(modelsDir, 'browser-chat.gguf'), gguf)
    fs.writeFileSync(
      path.join(modelsDir, 'active-model.json'),
      JSON.stringify({ id: 'browser-chat-model', primary: 'browser-chat.gguf', mmproj: null })
    )
    const executable = path.join(llamaDir, 'llama-server')
    fs.copyFileSync(path.resolve('e2e/fixtures/browser-chat-llama-server.mjs'), executable)
    fs.chmodSync(executable, 0o755)
    app = await launchOffGrid({
      env: {
        ...process.env,
        OFFGRID_USER_DATA: profileDir,
        OFFGRID_BIN_DIR: path.join(profileDir, 'bin'),
        OFFGRID_BROWSER_CHAT_LOG: modelLog,
        OFFGRID_PRO: '1',
        NODE_ENV: 'production',
        NO_PROXY: '127.0.0.1,localhost'
      }
    })
    page = await mainWindow(app)
    await completeOnboarding(page)
    browser = await pairedBrowser(app)
  })

  // Playwright requires the first callback argument to use object destructuring.
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await browser?.close()
    browser = null
    if (app) await closeAndWait(app)
    app = null
    if (modelLog && fs.existsSync(modelLog))
      fs.copyFileSync(modelLog, testInfo.outputPath('model-requests.jsonl'))
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true })
  })

  test('A browser chat shows in Desktop, renames, branches on retry, and stops cleanly', async () => {
    test.setTimeout(180_000)
    const conversationId = id()
    const started = await browser!.rpc('chat.start', {
      runId: id(),
      conversationId,
      prompt: FIRST,
      mode: 'chat'
    })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    const firstRun = (started.result as { runId: string }).runId
    const first = await readRun(firstRun)
    const answer = `Browser answer: ${FIRST}`
    expect(text(first.events)).toBe(answer)
    expect(first.events.some((event) => event.type === 'done')).toBe(true)

    // Desktop lists the chat and shows its answer.
    await page.getByRole('button', { name: 'Chat', exact: true }).click()
    await page.getByText(FIRST, { exact: true }).first().click()
    await expect(page.getByText(answer).first()).toBeVisible()

    // A rename in the browser shows in Desktop.
    const renamed = await browser!.rpc('conversations.put', {
      conversation: {
        id: conversationId,
        title: 'Riverside picnic',
        updatedAt: Date.now(),
        turns: [
          { role: 'user', content: FIRST },
          { role: 'assistant', content: answer }
        ]
      }
    })
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true)
    await expect(page.getByText('Riverside picnic', { exact: true }).first()).toBeVisible()

    // Retrying the first answer branches: the original chat keeps its turns.
    const retry = await browser!.rpc('chat.start', {
      runId: id(),
      conversationId,
      prompt: FIRST,
      mode: 'chat',
      branchFrom: 0
    })
    expect(retry.ok, JSON.stringify(retry)).toBe(true)
    const branch = await readRun((retry.result as { runId: string }).runId)
    expect(branch.conversationId).not.toBe(conversationId)
    const stored = await page.evaluate(
      async (ids) =>
        Promise.all(
          ids.map(async (conversation) =>
            (await window.api.getRagMessages(conversation)).map(
              (message: { role: string; content: string }) => `${message.role}: ${message.content}`
            )
          )
        ),
      [conversationId, branch.conversationId]
    )
    expect(stored[0]).toEqual([`user: ${FIRST}`, `assistant: ${answer}`])
    expect(stored[1]).toEqual([`user: ${FIRST}`, `assistant: ${answer}`])

    // A run stopped midway keeps its partial answer and asks its question once.
    const slow = 'Count slowly for the picnic'
    const counting = await browser!.rpc('chat.start', {
      runId: id(),
      conversationId,
      prompt: slow,
      mode: 'chat'
    })
    const countingRun = (counting.result as { runId: string }).runId
    await readRun(countingRun, (events) => text(events).includes('tok3 '))
    expect((await browser!.rpc('chat.stop', { runId: countingRun })).ok).toBe(true)
    const stopped = await readRun(countingRun)
    expect(stopped.done).toBe(true)
    const afterStop = await page.evaluate(
      async (conversation) =>
        (await window.api.getRagMessages(conversation)).map(
          (message: { role: string; content: string }) => ({
            role: message.role,
            content: message.content
          })
        ),
      conversationId
    )
    expect(afterStop.filter((message) => message.content === slow)).toHaveLength(1)
    expect(afterStop.at(-1)?.role).toBe('assistant')
    expect(afterStop.at(-1)?.content).toContain('tok1')

    // A tool switched off in Desktop is not offered to a browser chat.
    const clock = 'What time is it right now?'
    await browser!.rpc('chat.start', {
      runId: id(),
      conversationId: id(),
      prompt: clock,
      mode: 'chat'
    })
    await expect.poll(() => toolsOfferedFor(clock).length, { timeout: 30_000 }).toBeGreaterThan(0)
    expect(toolsOfferedFor(clock)[0]).toContain('get_datetime')
    await page.getByRole('button', { name: 'Active models', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).last().click()
    await page.getByRole('radio', { name: 'tools', exact: true }).click()
    // Tools are grouped and folded; open groups until the clock tool shows.
    const toggle = page.getByRole('switch', { name: 'Enable get_datetime', exact: true })
    const folded = page.locator('button[aria-expanded="false"]:has([role="heading"])')
    while (!(await toggle.isVisible()) && (await folded.count()) > 0) await folded.first().click()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    const clockAgain = 'What time is it there now?'
    await browser!.rpc('chat.start', {
      runId: id(),
      conversationId: id(),
      prompt: clockAgain,
      mode: 'chat'
    })
    await expect
      .poll(() => toolsOfferedFor(clockAgain).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
    expect(toolsOfferedFor(clockAgain)[0]).not.toContain('get_datetime')
  })
})
