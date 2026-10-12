import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SemanticDecision, BrowserSemanticDecisionRequest } from '../browser-playwright-policy'

const model = vi.hoisted(() => ({
  decisions: [] as SemanticDecision[],
  requests: [] as BrowserSemanticDecisionRequest[]
}))
vi.mock('../browser-playwright-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../browser-playwright-policy')>()),
  decideBrowserSemanticAction: async (request: BrowserSemanticDecisionRequest) => {
    model.requests.push(request)
    const decision = model.decisions.shift()
    if (!decision) throw new Error('No queued decision')
    return decision
  }
}))

import { runBrowserPlaywrightTask } from '../browser-playwright-task'
import { ExtensionSnapshotSession } from '../extension-snapshot-session'
import { UNCERTAIN_ACTION_NOTE, isUncertainActionTimeout } from '../browser-playwright-task-support'
import type { BrowserLink } from '../../extension-bridge/bridge-socket'
import type { PlaywrightToolResult, SemanticPageSession } from '../playwright-mcp-session'
import { VisionGuard } from '../../vision/vision-guard'

function decision(overrides: Partial<SemanticDecision> = {}): SemanticDecision {
  return {
    action: 'click',
    phase_id: null,
    element: 'Place order',
    ref: 'e1',
    text: null,
    key: null,
    values: null,
    start_element: null,
    start_ref: null,
    end_element: null,
    end_ref: null,
    url: null,
    evidence_ref: null,
    evidence_text: null,
    reason: '',
    summary: 'Place order',
    ...overrides
  }
}
const done = (): SemanticDecision => decision({ action: 'done', evidence_text: 'Order complete' })

function fixture(
  results: Array<PlaywrightToolResult | Error>,
  extension = false
): {
  run: () => ReturnType<typeof runBrowserPlaywrightTask>
  snapshot: ReturnType<typeof vi.fn>
  call: ReturnType<typeof vi.fn>
  onStep: ReturnType<typeof vi.fn>
  waitForUser: ReturnType<typeof vi.fn>
} {
  const snapshot = vi.fn(async () => ({
    text: `Order complete [ref=e1]\nOther action [ref=e2]\nSnapshot ${snapshot.mock.calls.length}`,
    isError: false
  }))
  const call = vi.fn(async () => {
    const result = results.shift()
    if (result instanceof Error) throw result
    if (!result) throw new Error('No queued action result')
    return result
  })
  let session: SemanticPageSession = { snapshot, call, recoverPage: snapshot }
  if (extension) {
    const link = {
      request: async (_op: string, args: Record<string, unknown>) =>
        args.tool === 'browser_snapshot' ? snapshot() : call()
    } as unknown as BrowserLink
    session = new ExtensionSnapshotSession(link, () => 7)
  }
  const onStep = vi.fn()
  const guard = new VisionGuard({ taskId: 'uncertain-test', kind: 'web_use' })
  const waitForUser = vi.fn(async () => undefined)
  return {
    snapshot,
    call,
    onStep,
    waitForUser,
    run: () =>
      runBrowserPlaywrightTask({
        goal: 'Place one order',
        plan: { version: 1, phases: [{ id: 'p1', title: 'Order' }] },
        session,
        guard,
        activeDriver: () => null,
        activeUrl: () => 'https://shop.test/',
        waitForUser,
        takeGuidance: () => [],
        onStep,
        onPhase: () => undefined,
        onProgress: () => undefined
      })
  }
}

beforeEach(() => {
  model.decisions = []
  model.requests = []
})

describe('uncertain browser actions', () => {
  it.each([
    { text: 'The action may have run.', isError: false, uncertain: true as const },
    { text: 'The page did not answer.', isError: true }
  ])('observes again and blocks a repeat from the extension: %s', async (result) => {
    const task = fixture([result], true)
    model.decisions.push(decision(), decision({ ref: 'e2' }), done())
    expect((await task.run()).ok).toBe(true)
    expect(task.call).toHaveBeenCalledTimes(1)
    expect(task.snapshot).toHaveBeenCalledTimes(3)
    expect(task.onStep).toHaveBeenCalledWith(UNCERTAIN_ACTION_NOTE)
    expect(model.requests[1]?.recoveryNote).toContain(UNCERTAIN_ACTION_NOTE)
    expect(model.requests[1]?.snapshot).toContain('Snapshot 2')
    expect(task.waitForUser).not.toHaveBeenCalled()
  })

  it('waits for user guidance after two uncertain inputs, before another decision', async () => {
    const task = fixture(
      [
        { text: 'No confirmation', isError: false, uncertain: true },
        { text: 'No confirmation', isError: false, uncertain: true }
      ],
      true
    )
    let release!: () => void
    task.waitForUser.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    model.decisions.push(decision(), decision({ action: 'press_key', key: 'Enter' }), done())
    const running = task.run()
    await vi.waitFor(() => expect(task.waitForUser).toHaveBeenCalledTimes(1))
    expect(model.requests).toHaveLength(2)
    expect(task.snapshot).toHaveBeenCalledTimes(3)
    release()
    expect((await running).handoffs).toBe(1)
    expect(model.requests[2]?.recoveryNote).toContain(UNCERTAIN_ACTION_NOTE)
  })

  it('resets the consecutive count after a definite result', async () => {
    const uncertain = { text: 'No confirmation', isError: false, uncertain: true as const }
    const task = fixture([uncertain, { text: 'Selected', isError: false }, uncertain])
    model.decisions.push(
      decision(),
      decision({ action: 'select_option', values: ['one'] }),
      decision({ action: 'type', ref: 'e2', text: 'Name' }),
      done()
    )
    expect((await task.run()).ok).toBe(true)
    expect(task.waitForUser).not.toHaveBeenCalled()
  })

  it('keeps a definite failure on the existing failure path', async () => {
    const task = fixture([{ text: 'Permission denied', isError: true }], true)
    model.decisions.push(decision())
    expect(await task.run()).toMatchObject({
      fallback: true,
      summary: 'Semantic action failed: Permission denied'
    })
    expect(task.snapshot).toHaveBeenCalledTimes(1)
    expect(task.onStep).not.toHaveBeenCalledWith(UNCERTAIN_ACTION_NOTE)
  })

  it.each([
    new Error('The browser did not answer cdp.send in time.'),
    {
      text: 'Protocol error (Input.dispatchMouseEvent): Electron debugger Input.dispatchMouseEvent timed out',
      isError: true
    }
  ])('treats a Playwright CDP input timeout as uncertain: %s', async (result) => {
    const task = fixture([result])
    model.decisions.push(decision(), decision({ ref: 'e2' }), done())
    expect((await task.run()).ok).toBe(true)
    expect(task.call).toHaveBeenCalledTimes(1)
    expect(task.snapshot).toHaveBeenCalledTimes(3)
    expect(task.onStep).toHaveBeenCalledWith(UNCERTAIN_ACTION_NOTE)
    expect(model.requests[1]?.recoveryNote).toContain(UNCERTAIN_ACTION_NOTE)
  })

  it('does not classify preflight, navigation, or ordinary action errors as uncertain', () => {
    expect(isUncertainActionTimeout(decision(), 'Playwright relay page sync timed out')).toBe(false)
    expect(isUncertainActionTimeout(decision(), 'Timeout 30000ms exceeded')).toBe(false)
    expect(
      isUncertainActionTimeout(
        decision({ action: 'navigate' }),
        'The browser did not answer cdp.send in time.'
      )
    ).toBe(false)
  })
})
