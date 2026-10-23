import { describe, expect, it } from 'vitest'
import {
  applyStreamViewEvent,
  clearStreamViewMessage,
  releaseStreamViewApplier,
  seedStreamViewMessage,
  streamViewMessage
} from '../MemoryChat/stream-view-store'

describe('a stream shown in two chat views', () => {
  it('writes each token once, and keeps writing when one view stops listening', () => {
    const left = {}
    const right = {}
    seedStreamViewMessage({ id: 's1', role: 'assistant', content: '', streaming: true })
    for (const view of [left, right])
      applyStreamViewEvent('s1', { type: 'content', text: 'Hel' }, view)
    for (const view of [right, left])
      applyStreamViewEvent('s1', { type: 'content', text: 'lo' }, view)
    expect(streamViewMessage('s1')?.content).toBe('Hello')

    releaseStreamViewApplier(left)
    applyStreamViewEvent('s1', { type: 'content', text: '!' }, right)
    expect(streamViewMessage('s1')?.content).toBe('Hello!')
    clearStreamViewMessage('s1')
  })
})
