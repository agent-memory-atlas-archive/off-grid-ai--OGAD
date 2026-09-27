// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AIRequestLogs } from '../AIRequestLogs'
import { SettingsCard, SettingsCardsGroup } from '../SettingsCard'

const row = {
  id: 'a',
  modality: 'text',
  source: 'Chat',
  model: 'Qwen 4B',
  backend: 'CUDA',
  status: 'completed',
  startedAt: 10000,
  durationMs: 1500,
  preview: 'Find a cafe'
}
const api = {
  aiLogsList: vi.fn(),
  aiLogsDetail: vi.fn(),
  aiLogsRelated: vi.fn(),
  aiLogsClear: vi.fn(),
  aiLogsAttachment: vi.fn(),
  aiLogsOpenWindow: vi.fn()
}
beforeEach(() => {
  window.localStorage.clear()
  for (const mock of Object.values(api)) mock.mockReset()
  api.aiLogsList.mockResolvedValue({ total: 1, rows: [row] })
  api.aiLogsDetail.mockResolvedValue({
    ...row,
    request: { text: 'Find a cafe near me' },
    response: 'Here are two cafes',
    metrics: { completionTokens: 5 }
  })
  api.aiLogsRelated.mockResolvedValue([])
  api.aiLogsOpenWindow.mockResolvedValue(undefined)
  api.aiLogsClear.mockResolvedValue(undefined)
  Object.assign(window, { api })
})
afterEach(cleanup)
describe('AI activity viewer', () => {
  it('has one heading in Settings and retains it in its own window', async () => {
    const view = render(
      <SettingsCardsGroup initialOpenId="AI activity">
        <SettingsCard title="AI activity" summary="Logs">
          <AIRequestLogs />
        </SettingsCard>
      </SettingsCardsGroup>
    )
    expect(screen.getAllByRole('heading', { name: 'AI activity' })).toHaveLength(1)
    await screen.findByText('Here are two cafes')
    view.unmount()
    render(<AIRequestLogs standalone />)
    expect(screen.getAllByRole('heading', { name: 'AI activity' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Open in new window' })).toBeNull()
    expect(screen.getByRole('region', { name: 'AI activity' }).className).toContain('w-full')
    expect(screen.getByRole('region', { name: 'AI activity' }).className).toContain('h-full')
    expect(screen.getByRole('region', { name: 'Request list' }).className).toContain(
      'overflow-hidden'
    )
    expect(screen.getByRole('region', { name: 'Request details' }).className).toContain(
      'overflow-hidden'
    )
    await screen.findByText('Here are two cafes')
  })
  it('opens a separate window without navigating away', async () => {
    render(<AIRequestLogs />)
    await userEvent.click(screen.getByRole('button', { name: 'Open in new window' }))
    expect(api.aiLogsOpenWindow).toHaveBeenCalledOnce()
    expect(await screen.findByText('Here are two cafes')).toBeTruthy()
  })
  it('filters by modality, status and search', async () => {
    render(<AIRequestLogs />)
    await userEvent.click(screen.getByRole('button', { name: 'Images' }))
    await waitFor(() =>
      expect(api.aiLogsList).toHaveBeenLastCalledWith(
        expect.objectContaining({ modality: 'image' })
      )
    )
    await userEvent.click(screen.getByRole('button', { name: 'Filters' }))
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'failed')
    await waitFor(() =>
      expect(api.aiLogsList).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' }))
    )
    await userEvent.type(screen.getByRole('searchbox'), 'cafe')
    await waitFor(() =>
      expect(api.aiLogsList).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'cafe' }))
    )
  })
  it('hides response payloads in readable and raw views', async () => {
    render(<AIRequestLogs />)
    await screen.findByText('Here are two cafes')
    await userEvent.click(screen.getByRole('button', { name: 'Show' }))
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Responses' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByText('Here are two cafes')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.queryByText(/Here are two cafes/)).toBeNull()
    expect(JSON.parse(window.localStorage.getItem('ai-activity-display')!).response).toBe(false)
  })
  it('requires confirmation to clear and shows the empty state', async () => {
    render(<AIRequestLogs />)
    await screen.findByText('Here are two cafes')
    await userEvent.click(screen.getByRole('button', { name: 'Clear history' }))
    expect(api.aiLogsClear).not.toHaveBeenCalled()
    api.aiLogsList.mockResolvedValue({ rows: [], total: 0 })
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Confirm clear activity' })).getByRole('button', {
        name: 'Delete history'
      })
    )
    await screen.findByText('No activity yet. Your next AI request will appear here.')
    expect(api.aiLogsClear).toHaveBeenCalledOnce()
  })
  it('shows errors and allows refresh', async () => {
    api.aiLogsList.mockRejectedValueOnce(new Error('Database is busy'))
    render(<AIRequestLogs />)
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Database is busy')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh activity' }))
    await screen.findByText('Here are two cafes')
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('shows a quiet empty detail view without inactive view controls', async () => {
    api.aiLogsList.mockResolvedValue({ rows: [], total: 0 })
    render(<AIRequestLogs standalone />)
    await screen.findByText('No activity yet. Your next AI request will appear here.')
    expect(screen.queryByRole('button', { name: 'Raw' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Readable' })).toBeNull()
    const live = screen.getByRole('button', { name: 'Live updates' })
    expect(live.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(live)
    expect(live.getAttribute('aria-pressed')).toBe('false')
  })
})
