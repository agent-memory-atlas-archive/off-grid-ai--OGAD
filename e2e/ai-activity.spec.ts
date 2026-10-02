import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

// A fresh profile with synthetic request bodies. No personal data or model downloads.
test('AI activity uses the window, filters records, and keeps the main window open', async ({
  playwright
}, testInfo) => {
  test.setTimeout(120_000)
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ai-activity-ui-'))
  const quote = (value: unknown): string => `'${String(value).replaceAll("'", "''")}'`
  const rows = ['text', 'image', 'tts', 'stt', 'embedding'].map((modality, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    modality,
    source: 'Synthetic verification',
    model: 'Test model',
    backend: 'Metal',
    status: 'completed',
    startedAt: Date.now() - index * 1000,
    durationMs: 1200,
    preview: `Synthetic ${modality} request`,
    request: { text: `Synthetic ${modality} input` },
    response: `Synthetic ${modality} response`,
    metrics: { completionTokens: 24 }
  }))
  execFileSync('sqlite3', [
    path.join(profile, 'memories.db'),
    `
    CREATE TABLE ai_request_logs (id TEXT PRIMARY KEY, parent_id TEXT, started_at INTEGER NOT NULL,
      duration_ms INTEGER, modality TEXT NOT NULL, status TEXT NOT NULL, model TEXT, backend TEXT,
      search TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT NOT NULL, bytes INTEGER NOT NULL);
    ${rows
      .map(
        (row) => `INSERT INTO ai_request_logs VALUES (${quote(row.id)},NULL,${row.startedAt},1200,
      ${quote(row.modality)},'completed','Test model','Metal',${quote(row.preview)},
      ${quote(JSON.stringify(row))},${quote(JSON.stringify(row))},1000);`
      )
      .join('\n')}
  `
  ])
  const app = await playwright._electron.launch({
    args: [process.env.OFFGRID_AI_ACTIVITY_APP ?? '.'],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_E2E_ISOLATED_INSTANCE: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_PRO: '0',
      OFFGRID_SEED: ''
    }
  })
  try {
    const main = await app.firstWindow()
    await main.waitForFunction(() => !!window.api?.aiLogsOpenWindow)
    const originalUrl = main.url()
    const windowPromise = app.waitForEvent('window')
    await main.evaluate(() => window.api.aiLogsOpenWindow())
    const activity = await windowPromise
    await expect(activity.getByText('Synthetic text response', { exact: true })).toBeVisible()
    await main.evaluate(() => window.api.aiLogsOpenWindow())
    expect(app.windows()).toHaveLength(2)
    expect(main.url()).toBe(originalUrl)
    for (const [width, height] of [
      [1600, 1000],
      [900, 700],
      [620, 600]
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => {
          const window = BrowserWindow.getAllWindows().find((item) =>
            item.webContents.getURL().endsWith('#ai-activity')
          )!
          window.setSize(size[0]!, size[1]!)
        },
        [width!, height!]
      )
      for (const theme of ['light', 'dark']) {
        await activity.evaluate((value) => window.ogTheme.set(value as 'light' | 'dark'), theme)
        await activity.evaluate(() => document.fonts.ready)
        const layout = await activity.evaluate(() => {
          const bounds = document
            .querySelector('section[aria-label="AI activity"]')!
            .getBoundingClientRect()
          return {
            width: bounds.width,
            height: bounds.height,
            innerWidth,
            innerHeight,
            overflow: document.documentElement.scrollWidth > innerWidth
          }
        })
        expect(layout.width).toBe(layout.innerWidth)
        expect(layout.height).toBe(layout.innerHeight)
        expect(layout.overflow).toBe(false)
        await activity.screenshot({
          path: testInfo.outputPath(`activity-${theme}-${width}.png`),
          animations: 'disabled'
        })
      }
    }
    await activity.getByRole('button', { name: 'Images', exact: true }).click()
    await expect(activity.getByText('Synthetic image response', { exact: true })).toBeVisible()
    await activity.getByRole('button', { name: 'Show', exact: true }).click()
    await activity.getByRole('menuitemcheckbox', { name: 'Responses', exact: true }).click()
    await activity.keyboard.press('Escape')
    await expect(activity.getByText('Synthetic image response', { exact: true })).toHaveCount(0)
    await activity.getByRole('button', { name: 'Raw', exact: true }).click()
    await expect(activity.getByText(/Synthetic image response/)).toHaveCount(0)
    await activity.getByRole('button', { name: 'Clear history', exact: true }).click()
    await activity.getByRole('button', { name: 'Delete history', exact: true }).click()
    await expect(activity.getByText('No requests match these filters.')).toBeVisible()
    await activity.close()
    expect(main.isClosed()).toBe(false)
  } finally {
    await app.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
