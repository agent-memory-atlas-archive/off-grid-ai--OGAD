import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../components/MemoryChat/types'
import { priorAnswerVersions } from '../chat-versions'
import {
  answerVersionsNavigable,
  liveAnswerVersionView,
  nextLiveVersionIndex
} from '../live-answer-versions'

const saved: ChatMessage = {
  id: 'saved',
  role: 'assistant',
  content: 'Original explanation',
  reasoning: 'Original reasoning'
}
const prior = priorAnswerVersions(saved)!
const streaming: ChatMessage = {
  id: 'stream',
  role: 'assistant',
  content: 'Partial replacement',
  reasoningRequested: true,
  streaming: true,
  activity: { kind: 'answering' },
  variants: [...prior, ''],
  variantIndex: prior.length
}

describe('answer versions while a new version streams', () => {
  it('shows the arrows on a streaming or stopped reply that has more than one version', () => {
    expect(answerVersionsNavigable(streaming, undefined)).toBe(true)
    expect(answerVersionsNavigable(streaming, 'user')).toBe(true)
    expect(
      answerVersionsNavigable(
        { ...streaming, streaming: false, content: '', turnStatus: 'cancelled' },
        undefined
      )
    ).toBe(true)
  })

  it('keeps the arrows off single answers, notices, and replies followed by more work', () => {
    expect(answerVersionsNavigable(saved, undefined)).toBe(false)
    expect(answerVersionsNavigable({ ...streaming, notice: true }, undefined)).toBe(false)
    expect(answerVersionsNavigable(streaming, 'assistant')).toBe(false)
    expect(answerVersionsNavigable(streaming, 'tool')).toBe(false)
    expect(answerVersionsNavigable({ ...streaming, role: 'user' }, undefined)).toBe(false)
  })

  it('shows the live version until the reader steps back to an earlier one', () => {
    expect(liveAnswerVersionView(streaming, null)).toBe(streaming)
    expect(liveAnswerVersionView(streaming, 1)).toBe(streaming)

    const earlier = liveAnswerVersionView(streaming, 0)
    expect(earlier.content).toBe('Original explanation')
    expect(earlier.reasoning).toBe('Original reasoning')
    expect(earlier.variantIndex).toBe(0)
    expect(earlier.variants).toHaveLength(2)
    expect(earlier.streaming).toBe(false)
    expect(earlier.activity).toBeUndefined()
    expect(earlier.id).toBe('stream')
  })

  it('never projects a finished reply; its own selection owns the version', () => {
    const finished = { ...streaming, streaming: false }
    expect(liveAnswerVersionView(finished, 0)).toBe(finished)
  })

  it('steps between versions and returns to the live one at the newest index', () => {
    expect(nextLiveVersionIndex(streaming, null, -1)).toBe(0)
    expect(nextLiveVersionIndex(streaming, 0, -1)).toBe(0)
    expect(nextLiveVersionIndex(streaming, 0, 1)).toBeNull()
    expect(nextLiveVersionIndex(streaming, null, 1)).toBeNull()
  })
})
