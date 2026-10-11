// web_use in the user's default browser, through the paired extension.
//
// Same task as the in-app browser (BrowserHost): the same execution plan, the same Playwright
// semantic loop over the same relay, the same guard, task history, progress and Stop. Only
// the pages differ: they are tabs in the user's own browser (extension-tab-pages.ts), so the
// user watches the work where they browse, signed in as themselves. There is no in-app pane.
//
// The visual fallback (canvas, maps, remote desktops) needs OGAD's own view, so here a page
// that needs it ends the task with that reason instead of guessing.
//
// Chromium tabs are driven by Playwright over the debugger protocol, and from inside the page
// while Chrome refuses the debugger (debugger-fallback-session.ts). Firefox has no debugger for
// extensions, so there the loop's Playwright tools are always answered by the extension in the
// page (extension-snapshot-session.ts); openTaskSession picks from what the browser reports.

import { automationTaskReadStatus } from '@offgrid/automation'
import { encodeTaskPhase } from '../../shared/task-execution-plan'
import type { BrowserLink } from '../extension-bridge/bridge-socket'
import { getTaskExecutionDevice, recordTaskRun, reportTaskProgress } from '../tasks/task-history'
import { registerTaskGuideHandler, TASK_GUIDANCE_TRACE } from '../tasks/task-guide'
import { prepareTaskExecutionPlan } from '../tasks/task-execution-plan-service'
import { retryPlanningGoal } from '../tasks/task-retry'
import {
  controlVisionTask,
  registerVisionSession,
  waitForVisionUser
} from '../vision/vision-controller'
import { VisionGuard } from '../vision/vision-guard'
import { BrowserDriver } from './browser-driver'
import { runBrowserPlaywrightTask } from './browser-playwright-task'
import type { BrowserRailHost, BrowserTaskRequest, WebTaskResult } from './browser-rail'
import { ElectronPlaywrightRelay } from './electron-playwright-relay'
import { createExtensionPageProvider, type ExtensionTabContents } from './extension-tab-pages'
import { ExtensionSnapshotSession } from './extension-snapshot-session'
import {
  DebuggerFallbackSession,
  type DebuggerConnection,
  type PageControl
} from './debugger-fallback-session'
import { PlaywrightMcpSession, type SemanticPageSession } from './playwright-mcp-session'

const START_URL = 'https://www.google.com'

type PageProvider = ReturnType<typeof createExtensionPageProvider>

export interface TaskSession {
  session: SemanticPageSession
  /** The pointer overlay; null where the page is driven from inside (no debugger). */
  driver: () => BrowserDriver | null
  close: () => Promise<void>
}

/** Said in the task's steps when control moves between the debugger and the page. */
export const CONTROL_STEPS: Record<PageControl, string> = {
  page: 'Chrome blocked debugger control because another extension (often a password manager) added a frame to this page. Continuing with page controls until it goes.',
  debugger: 'Debugger control is back.'
}

/** Attach Chrome's debugger to the task tab and start Playwright MCP over it. */
async function connectDebugger(
  pages: PageProvider,
  tab: () => ExtensionTabContents
): Promise<DebuggerConnection> {
  const relay = new ElectronPlaywrightRelay(pages)
  const playwright = new PlaywrightMcpSession(relay)
  const target = tab()
  const close = async (): Promise<void> => {
    await playwright.close().catch(() => undefined)
    await relay.stop().catch(() => undefined)
  }
  try {
    target.debugger.attach()
    // Await Chrome's attachment before starting MCP, including its permission refusal.
    await target.debugger.sendCommand('Target.getTargetInfo')
    await playwright.connect()
  } catch (error) {
    await close()
    target.debugger.detach()
    throw error
  }
  return { session: playwright, close }
}

/**
 * Drive the task tab the way this browser allows: Playwright over the debugger protocol where
 * it has one (Chromium), falling back to the extension's in-page answers while Chrome refuses
 * the debugger; in-page only where there is none (Firefox).
 */
export async function openTaskSession(
  link: BrowserLink,
  pages: PageProvider,
  tab: ExtensionTabContents,
  onStep: (note: string) => void = () => undefined
): Promise<TaskSession> {
  const caps = (await link.request('browser.caps')) as { cdp?: unknown } | null
  const current = (): ExtensionTabContents => pages.active() ?? tab
  const page = new ExtensionSnapshotSession(link, () => current().tabId)
  if (caps?.cdp !== true) {
    return { session: page, driver: () => null, close: async () => undefined }
  }
  const session = new DebuggerFallbackSession({
    connect: () => connectDebugger(pages, current),
    page,
    onSwitch: (to) => onStep(CONTROL_STEPS[to])
  })
  return {
    session,
    driver: () => (session.usesDebugger() ? new BrowserDriver(current().transport()) : null),
    close: () => session.close()
  }
}

/**
 * `startTabId`: the tab the browser offered for this task (browser-start-tab.ts). The task
 * starts there instead of in a new tab; without it, a new tab opens as before.
 */
export function createExtensionBrowserHost(
  link: () => BrowserLink | null,
  startTabId?: number
): BrowserRailHost {
  return {
    async runTask(request: BrowserTaskRequest): Promise<WebTaskResult> {
      const browser = link()
      if (!browser) {
        return {
          ok: false,
          summary: 'Your browser is not connected to Off Grid AI Desktop.',
          steps: [],
          takeovers: 0,
          finalUrl: ''
        }
      }
      return runInBrowser(browser, request, startTabId)
    }
  }
}

async function runInBrowser(
  link: BrowserLink,
  request: BrowserTaskRequest,
  startTabId: number | undefined
): Promise<WebTaskResult> {
  const { goal, url, taskId, journeyId, checkpoint } = request
  const guard = new VisionGuard({ taskId, kind: 'web_use' })
  const controller = new AbortController()
  const steps: string[] = checkpoint ? [...checkpoint.steps] : []
  const device = getTaskExecutionDevice()
  const pages = createExtensionPageProvider(link)

  const setState = (status: Parameters<typeof recordTaskRun>[0]['status'], summary = ''): void => {
    recordTaskRun({
      taskId,
      journeyId,
      kind: 'web_use',
      title: goal,
      status,
      summary,
      steps: [...steps],
      executionDeviceId: device.id,
      executionDeviceName: device.name,
      lastUrl: pages.active()?.getURL() ?? ''
    })
  }
  const recordStep = (note: string): void => {
    steps.push(note)
    recordTaskRun({ taskId, journeyId, kind: 'web_use', title: goal, steps: [...steps] })
  }
  const releaseSession = registerVisionSession(taskId, guard, controller, (_s, status, action) =>
    setState(status, action)
  )
  const guidance: string[] = [...(checkpoint?.guidance ?? [])]
  const releaseGuidance = registerTaskGuideHandler(taskId, (text) => {
    guidance.push(text)
    recordStep(TASK_GUIDANCE_TRACE)
    controlVisionTask('resume', taskId)
    return true
  })
  // Leaving the task must not leave the browser's "is debugging" bar up.
  const stopOnDisconnect = link.onClose(() => controller.abort('The browser disconnected.'))

  try {
    setState('running', `Working in ${link.browser.name}`)
    const plan =
      checkpoint?.plan ??
      (await prepareTaskExecutionPlan(
        { goal: retryPlanningGoal(goal, checkpoint), surface: 'web', signal: controller.signal },
        recordStep
      ))
    let tab: ExtensionTabContents
    if (startTabId === undefined) {
      const start = url ?? START_URL
      tab = await pages.open(start)
      recordStep(`opened ${start} in ${link.browser.name}`)
    } else {
      // The user's own tab, left where it is unless the task names a page.
      tab = await pages.adopt(startTabId, taskId, url)
      recordStep(`working in your tab in ${link.browser.name}`)
    }
    const task = await openTaskSession(link, pages, tab, recordStep)
    const semantic = await runBrowserPlaywrightTask({
      goal,
      plan,
      session: task.session,
      guard,
      activeDriver: task.driver,
      activeUrl: () => (pages.active() ?? tab).getURL(),
      waitForUser: (why, signal) => waitForVisionUser(taskId, why, signal),
      takeGuidance: () => guidance.splice(0),
      onStep: recordStep,
      onPhase: (phaseId) => recordStep(encodeTaskPhase(phaseId)),
      onProgress: (currentStep, phase, action) =>
        reportTaskProgress({
          taskId,
          journeyId,
          kind: 'web_use',
          title: goal,
          status: 'running',
          phase,
          currentStep,
          currentAction: action
        }),
      signal: controller.signal
    }).finally(task.close)

    const finalUrl = (pages.active() ?? tab).getURL()
    if ((semantic.fallback || !semantic.ok) && !guard.isHalted) guard.fail(semantic.summary)
    else if (semantic.ok && guard.automationStatus !== 'completed') {
      guard.fail('Web Use ended without a verified completion state.')
    }
    const status = automationTaskReadStatus(guard.automationStatus)
    const ok = semantic.ok && !semantic.fallback && status === 'done'
    const summary = ok ? semantic.summary : guard.snapshot().failure || semantic.summary
    setState(status, summary)
    return { ok, summary, steps: [...steps], takeovers: semantic.handoffs, finalUrl }
  } catch (error) {
    const detail =
      controller.signal.aborted && typeof controller.signal.reason === 'string'
        ? controller.signal.reason
        : error instanceof Error
          ? error.message
          : String(error)
    recordStep(`error: ${detail}`)
    const summary = `Web Use stopped: ${detail}`
    if (!guard.isHalted) guard.fail(summary)
    setState(automationTaskReadStatus(guard.automationStatus), summary)
    return { ok: false, summary, steps: [...steps], takeovers: 0, finalUrl: '' }
  } finally {
    stopOnDisconnect()
    releaseGuidance()
    releaseSession()
    await pages.closeAll()
  }
}
