import { describe, expect, it } from 'vitest'
import type { BrowserLink } from '../../extension-bridge/bridge-socket'
import type { SocketOp } from '../../extension-bridge/bridge-socket-protocol'
import { ExtensionSnapshotSession } from '../extension-snapshot-session'
import {
  CONTROL_STEPS,
  openTaskSession,
  PLAN_SNAPSHOT_CHARS,
  startingPage,
  startingState
} from '../extension-browser-host'
import { DEBUGGER_BLOCKED } from '../debugger-fallback-session'
import { createExtensionPageProvider } from '../extension-tab-pages'

// Firefox has no debugger protocol for extensions, so the loop's Playwright tools go to the
// extension (page.call). A stand-in link plays the browser.

function fakeLink(reply: (op: SocketOp, args: Record<string, unknown>) => unknown): BrowserLink & {
  calls: Array<{ op: SocketOp; args: Record<string, unknown> }>
} {
  const calls: Array<{ op: SocketOp; args: Record<string, unknown> }> = []
  return {
    browser: { id: 'device000001', name: 'Firefox extension', publicKey: 'k', pairedAt: 1 },
    calls,
    async request(op, args = {}) {
      calls.push({ op, args })
      return reply(op, args)
    },
    onEvent: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined
  }
}

const SNAPSHOT = '### Page state\n- Page Snapshot:\n```yaml\n- button "Go" [ref=e1]\n```'

describe('ExtensionSnapshotSession', () => {
  it('sends the loop’s Playwright tools to the task tab and returns their answers', async () => {
    const link = fakeLink((_op, args) =>
      args.tool === 'browser_snapshot'
        ? { text: SNAPSHOT, isError: false }
        : { text: 'Clicked "Go".', isError: false }
    )
    const session = new ExtensionSnapshotSession(link, () => 41)
    expect(await session.snapshot()).toEqual({ text: SNAPSHOT, isError: false })
    expect(await session.call('browser_click', { element: 'Go', target: 'e1' })).toEqual({
      text: 'Clicked "Go".',
      isError: false
    })
    await session.recoverPage('https://shop.test/')
    await session.recoverPage(undefined)
    expect(link.calls.map((c) => [c.op, c.args])).toEqual([
      ['page.call', { tabId: 41, tool: 'browser_snapshot', args: {} }],
      ['page.call', { tabId: 41, tool: 'browser_click', args: { element: 'Go', target: 'e1' } }],
      ['page.call', { tabId: 41, tool: 'browser_navigate', args: { url: 'https://shop.test/' } }],
      ['page.call', { tabId: 41, tool: 'browser_snapshot', args: {} }]
    ])
  })

  it('turns a refusal or an unreadable answer into a tool error the loop can see', async () => {
    const refusing = new ExtensionSnapshotSession(
      fakeLink(() => {
        throw new Error('That tab is not part of this task.')
      }),
      () => 1
    )
    expect(await refusing.snapshot()).toEqual({
      text: 'That tab is not part of this task.',
      isError: true
    })
    const garbled = new ExtensionSnapshotSession(
      fakeLink(() => ({ nope: 1 })),
      () => 1
    )
    expect((await garbled.snapshot()).isError).toBe(true)
    const aborted = new AbortController()
    aborted.abort()
    await expect(refusing.snapshot(aborted.signal)).rejects.toThrow()
  })
})

describe('openTaskSession', () => {
  it('uses the in-page session, and never the debugger, when the browser has none', async () => {
    const link = fakeLink((op, args) =>
      op === 'browser.caps'
        ? { cdp: false }
        : op === 'tab.create'
          ? { tabId: 7, url: String(args.url), title: '' }
          : { text: SNAPSHOT, isError: false }
    )
    const pages = createExtensionPageProvider(link)
    const tab = await pages.open('https://shop.test/')
    const task = await openTaskSession(link, pages, tab)
    expect(task.session).toBeInstanceOf(ExtensionSnapshotSession)
    expect(task.driver()).toBeNull()
    expect((await task.session.snapshot()).text).toBe(SNAPSHOT)
    await task.close()
    expect(link.calls.map((c) => c.op)).toEqual(['tab.create', 'browser.caps', 'page.call'])
  })
  it('answers from the page while Chrome refuses the debugger, and says why', async () => {
    // Chrome refuses to attach while another extension's frame (a password manager's menu)
    // is in the tab. Before, the whole task fell back for good; now the page answers until
    // the debugger can attach again.
    const link = fakeLink((op, args) => {
      if (op === 'browser.caps') return { cdp: true }
      if (op === 'tab.create') return { tabId: 7, url: String(args.url), title: '' }
      if (op === 'cdp.attach') throw new Error(DEBUGGER_BLOCKED)
      return op === 'page.call' ? { text: SNAPSHOT, isError: false } : null
    })
    const pages = createExtensionPageProvider(link)
    const tab = await pages.open('https://shop.test/')
    const steps: string[] = []
    const task = await openTaskSession(link, pages, tab, (note) => steps.push(note))
    expect((await task.session.snapshot()).text).toBe(SNAPSHOT)
    expect(task.driver()).toBeNull()
    expect(steps).toEqual([CONTROL_STEPS.page])
    await task.close()
    expect(link.calls.map((c) => c.op)).toEqual([
      'tab.create',
      'browser.caps',
      'cdp.attach',
      'cdp.detach',
      'page.call'
    ])
  })
})

describe('startingPage', () => {
  it('tells the planner which page is already open, so it plans no step to open it', () => {
    // Found live: the plan began "Navigate to the sign-up page" while the user was on it.
    const tab = { getURL: () => 'https://shop.test/signup', getTitle: () => 'Create Your Account' }
    expect(startingPage(tab)).toBe(
      'The task starts in the browser tab at https://shop.test/signup ("Create Your Account"). That page is already open: plan from it, with no step to open or reload it.'
    )
    expect(startingPage({ ...tab, getTitle: () => '  ' })).toContain(
      'https://shop.test/signup. That'
    )
  })
})

describe('startingState', () => {
  const tab = { getURL: () => 'https://shop.test/apply', getTitle: () => 'Apply' }
  const session = (
    text: string,
    isError = false
  ): { snapshot: () => Promise<{ text: string; isError: boolean }> } => ({
    snapshot: async () => ({ text, isError })
  })

  it("gives the planner what the page shows, so the plan names this page's controls", async () => {
    // Found live: a plan for Name, Company and Website fields on a page with one email box.
    const state = await startingState(
      tab,
      session('- textbox "Email" [ref=e1]\n- button "Sign Up / Login" [ref=e2]')
    )
    expect(state).toContain(startingPage(tab))
    expect(state).toContain('What the page shows now:\n- textbox "Email" [ref=e1]')
  })

  it('cuts a long page, and plans from the URL alone when the page cannot be read', async () => {
    const long = await startingState(tab, session('x'.repeat(PLAN_SNAPSHOT_CHARS + 50)))
    expect(long).toContain('(page cut here)')
    expect(long.length).toBeLessThan(PLAN_SNAPSHOT_CHARS + 400)
    expect(await startingState(tab, session('boom', true))).toBe(startingPage(tab))
    const failing = { snapshot: async () => Promise.reject(new Error('detached')) }
    expect(await startingState(tab, failing)).toBe(startingPage(tab))
  })
})

describe('startingState on a page still loading', () => {
  it('waits for the page to show controls before the planner reads it', async () => {
    // Found live: a tab just opened gave the planner an empty page, and it planned blind.
    const tab = { getURL: () => 'https://news.test/', getTitle: () => 'News' }
    const reads = ['', '- link "Top story" [ref=e1]']
    const session = {
      snapshot: async (): Promise<{ text: string; isError: boolean }> => ({
        text: reads.length > 1 ? (reads.shift() as string) : reads[0]!,
        isError: false
      })
    }
    expect(await startingState(tab, session)).toContain('- link "Top story" [ref=e1]')
  })
})
