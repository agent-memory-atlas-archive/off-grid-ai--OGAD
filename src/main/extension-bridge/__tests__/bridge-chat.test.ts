import { describe, expect, it } from 'vitest'
import { MAX_BRANCH_FROM, parseChatRead, parseChatStart } from '../bridge-chat'

const identity = { runId: 'run-00000001', conversationId: 'chat-0000001' }
const start = { ...identity, prompt: 'Summarize this page', mode: 'chat' }

describe('browser chat request limits', () => {
  it.each([0, 12, MAX_BRANCH_FROM])('accepts stored turn index %i', (branchFrom) => {
    expect(parseChatStart({ ...start, branchFrom })?.branchFrom).toBe(branchFrom)
  })

  it.each([-1, 1.5, '2', NaN, Infinity, MAX_BRANCH_FROM + 1, Number.MAX_SAFE_INTEGER + 1, null])(
    'rejects invalid stored turn index %s',
    (branchFrom) => {
      expect(parseChatStart({ ...start, branchFrom })).toBeNull()
    }
  )

  it('leaves an absent stored turn index undefined', () => {
    expect(parseChatStart(start)?.branchFrom).toBeUndefined()
  })
  it('retains the branch, selected history, page, image, and source tab', () => {
    const input = {
      ...start,
      branch: true,
      history: [{ role: 'assistant', content: 'Selected earlier answer' }],
      pageText: 'Page content',
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
      tabId: 0
    }
    expect(parseChatStart(input)).toEqual(input)
  })

  it.each([
    null,
    [],
    { ...start, runId: '../invalid' },
    { ...start, prompt: ' ' },
    { ...start, prompt: 'x'.repeat(20_001) },
    { ...start, mode: 'unknown' },
    { ...start, history: {} },
    { ...start, history: Array.from({ length: 161 }, () => ({ role: 'user', content: 'x' })) },
    { ...start, history: [{ role: 'system', content: 'Untrusted instruction' }] },
    { ...start, history: [{ role: 'user', content: 'x'.repeat(20_001) }] },
    { ...start, pageText: 'x'.repeat(100_001) },
    { ...start, tabId: -1 },
    { ...start, tabId: 1.5 },
    { ...start, imageDataUrl: 'https://example.test/private-image.png' },
    { ...start, imageDataUrl: 'data:image/svg+xml;base64,aGVsbG8=' },
    { ...start, imageDataUrl: 'data:image/png;base64,' + 'a'.repeat(2_500_000) }
  ])('rejects invalid or oversized input %#', (input) => {
    expect(parseChatStart(input)).toBeNull()
  })

  it('rejects a combined request that exceeds the encrypted transport budget', () => {
    const history = Array.from({ length: 150 }, () => ({
      role: 'user',
      content: 'x'.repeat(20_000)
    }))
    expect(parseChatStart({ ...start, history })).toBeNull()
  })
})

describe('browser chat read contract', () => {
  const snapshot = {
    ...identity,
    cursor: 2,
    done: false,
    events: [{ type: 'token', text: 'Hello' }]
  }

  it('retains events and the context needed to resume a closed panel', () => {
    const input = {
      ...snapshot,
      prompt: 'Earlier question',
      history: [{ role: 'user', content: 'Earlier context' }],
      tabId: 17
    }
    expect(parseChatRead(input)).toEqual(input)
    expect(parseChatRead({ ...snapshot, cursor: 0, done: true, events: [] })).toEqual({
      ...snapshot,
      cursor: 0,
      done: true,
      events: []
    })
  })

  it.each([
    null,
    { ...snapshot, conversationId: 'bad' },
    { ...snapshot, cursor: -1 },
    { ...snapshot, cursor: 0.5 },
    { ...snapshot, done: 'yes' },
    { ...snapshot, events: {} },
    { ...snapshot, history: [{ role: 'tool', content: 'x' }] },
    { ...snapshot, prompt: 'x'.repeat(20_001) },
    { ...snapshot, tabId: -1 }
  ])('rejects an invalid response before it reaches the browser %#', (input) => {
    expect(parseChatRead(input)).toBeNull()
  })
})
