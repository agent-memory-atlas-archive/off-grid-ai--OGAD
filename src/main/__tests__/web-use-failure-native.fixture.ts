// Real task host, model client, page session and task history. Only the external browser
// extension and HTTP model provider use contract-faithful synthetic boundaries.
import { app, BrowserWindow } from 'electron'
import { registerBrowserViewIpc, disposeBrowserHost } from '../browser/browser-host'
import { controlVisionTask } from '../vision/vision-controller'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserLink } from '../extension-bridge/bridge-socket'
import { createExtensionBrowserHost } from '../browser/extension-browser-host'
import type { WebTaskResult } from '../browser/browser-rail'
import { setRemoteVisionServerSettings } from '../vision/remote-vision-server'
import { getTaskRun } from '../tasks/task-history'
import { getDB } from '../database'

void app.whenReady().then(async () => {
  let window: BrowserWindow | undefined
  let holdModel = false
  let modelStarted!: () => void
  const pendingModel = new Promise<void>((resolve) => {
    modelStarted = resolve
  })
  let modelRequests = 0
  let modelFails = true
  const server = createServer((req, res) => {
    req.resume()
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'synthetic/text', object: 'model' }] }))
      return
    }
    if (holdModel) {
      modelStarted()
      return
    }
    modelRequests += 1
    if (modelFails) {
      res.writeHead(402, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Insufficient credits' } }))
      return
    }
    const content = JSON.stringify({
      action: 'fallback',
      phase_id: null,
      element: null,
      ref: null,
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
      reason: 'The notification content is drawn on a canvas with no readable controls.',
      summary: ''
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    )
  })
  const link: BrowserLink = {
    browser: {
      id: 'synthetic-browser',
      name: 'Synthetic browser',
      publicKey: 'synthetic',
      pairedAt: 1
    },
    async request(op, args = {}) {
      if (op === 'browser.caps') return { cdp: false }
      if (op === 'tab.adopt')
        return { tabId: args.tabId, url: 'https://synthetic.test/', title: 'Synthetic page' }
      if (op === 'page.call') return { text: '- button "Notifications" [ref=e1]', isError: false }
      if (op === 'cdp.detach') return {}
      throw new Error(`Unexpected browser operation: ${op}`)
    },
    onEvent: () => () => {},
    onClose: () => () => {},
    close: () => {}
  }
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    setRemoteVisionServerSettings({
      provider: 'openrouter',
      name: 'Synthetic model',
      model: 'synthetic/text',
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      apiKey: 'synthetic-key'
    })
    const run = (taskId: string): Promise<WebTaskResult> =>
      createExtensionBrowserHost(() => link, 42).runTask({
        goal: 'Read unread notifications',
        taskId,
        journeyId: taskId,
        checkpoint: {
          taskId,
          steps: [],
          plan: { version: 1, phases: [{ id: 'read', title: 'Read notifications' }] }
        }
      })
    const failed = await run('model-unavailable')
    assert.equal(failed.ok, false)
    assert.match(failed.summary, /402/)
    assert.match(failed.summary, /Insufficient credits/)
    assert.doesNotMatch(failed.summary, /visual control|Switch Tasks/)
    assert.equal(getTaskRun('model-unavailable')?.summary, failed.summary)
    modelFails = false
    const visual = await run('visual-page')
    assert.equal(visual.ok, false)
    assert.match(visual.summary, /canvas with no readable controls/)
    assert.equal(modelRequests, 2)
    holdModel = true
    const running = run('external-active')
    await pendingModel
    registerBrowserViewIpc()
    window = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
    })
    await window.loadURL('data:text/html,<title>Synthetic browser task</title>')
    assert.equal(
      await window.webContents.executeJavaScript(
        "require('electron').ipcRenderer.invoke('browser:reopen', 'external-active')"
      ),
      false
    )
    const sessions = await window.webContents.executeJavaScript(
      "require('electron').ipcRenderer.invoke('browser:get-sessions')"
    )
    assert.deepEqual(
      sessions.sessions,
      [],
      'Opening task details must not allocate a duplicate browser page'
    )
    controlVisionTask('stop', 'external-active')
    await running
    console.log('WEB_USE_FAILURE_NATIVE_PASSED')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    window?.destroy()
    disposeBrowserHost()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    getDB().close()
    app.exit(process.exitCode ? 1 : 0)
  }
})
