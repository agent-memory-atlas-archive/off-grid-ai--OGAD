import { describe, expect, it } from 'vitest'
import type { BrowserLink } from '../../extension-bridge/bridge-socket'
import type { SocketOp } from '../../extension-bridge/bridge-socket-protocol'
import { ExtensionSnapshotSession } from '../extension-snapshot-session'
import { openTaskSession } from '../extension-browser-host'
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
})
