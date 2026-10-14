import { describe, expect, it } from 'vitest'
import type { ActiveChatStreamContract } from '../../../../shared/ipc-contracts'
import type { ChatMessage } from '../../components/MemoryChat/types'
import { priorAnswerVersions, selectAnswerVersion, withAnswerVersions } from '../chat-versions'
import { restoredStreamMessage, withRestoredStream } from '../chat-stream-restore'

const saved: ChatMessage = { id: 'saved', role: 'assistant', content: 'Original explanation' }
const prior = priorAnswerVersions(saved)!
const stream: ActiveChatStreamContract = {
  streamId: 'stream-1',
  conversationId: 'conversation-a',
  messageId: 'minted-by-main',
  content: 'Streaming replacement',
  reasoning: '',
  reasoningRequested: false,
  phase: 'answering'
}
const senderView: ChatMessage = {
  id: 'stream-1',
  role: 'assistant',
  content: 'Streaming repl',
  streaming: true,
  replacementMessageId: 'saved',
  variants: [...prior, ''],
  variantIndex: prior.length
}

describe('restoring a regenerated answer after the chat view remounts', () => {
  it('keeps the replaced answer and its versions from the sender view, with main content', () => {
    const restored = restoredStreamMessage(stream, senderView)
    expect(restored).toMatchObject({
      id: 'stream-1',
      replacementMessageId: 'saved',
      content: 'Streaming replacement',
      streaming: true,
      variantIndex: 1
    })
    expect(restored.variants).toHaveLength(2)
    expect(selectAnswerVersion({ ...restored, streaming: false }, -1).content).toBe(
      'Original explanation'
    )
  })

  it('restores an ordinary stream without versions when no sender view remains', () => {
    const restored = restoredStreamMessage(stream)
    expect(restored.replacementMessageId).toBe('minted-by-main')
    expect(restored.variants).toBeUndefined()
    expect(restoredStreamMessage(stream, { ...senderView, id: 'another-stream' }).variants).toBe(
      undefined
    )
  })

  it('leaves the saved answer in place once the stream has moved on to its image', () => {
    const imagePhase = restoredStreamMessage(
      { ...stream, content: '', phase: 'generating_image' },
      senderView
    )
    expect(imagePhase.replacementMessageId).toBe('minted-by-main')
    expect(imagePhase.variants).toBeUndefined()
  })

  it('shows the restored stream in place of the saved answer it replaces', () => {
    const restored = restoredStreamMessage(stream, senderView)
    const user: ChatMessage = { id: 'question', role: 'user', content: 'Explain' }
    expect(withRestoredStream([user, saved], restored).map(({ id }) => id)).toEqual([
      'question',
      'stream-1'
    ])
    const merged = withRestoredStream([user, { ...senderView, content: 'stale' }], restored)
    expect(merged.map(({ id }) => id)).toEqual(['question', 'stream-1'])
    expect(merged[1]!.content).toBe('Streaming replacement')
  })
})

describe('a regenerated image answer', () => {
  it('keeps earlier versions in memory and in the stored context, naming the image file', () => {
    const image: ChatMessage = {
      id: 'image-answer',
      role: 'assistant',
      content: 'Generated for: a red fox',
      image: 'data:image/png;base64,AAAA',
      imagePath: '/images/fox-2.png',
      context: { imageRef: { id: 'fox-2', path: '/images/fox-2.png' } } as ChatMessage['context']
    }
    const answer = withAnswerVersions(image, prior)
    expect(answer.variants).toHaveLength(2)
    expect(answer.variantIndex).toBe(1)
    expect(answer.context).toMatchObject({
      imageRef: { id: 'fox-2', path: '/images/fox-2.png' },
      variantIndex: 1,
      variants: [
        expect.objectContaining({ content: 'Original explanation' }),
        expect.objectContaining({ content: 'Generated for: a red fox' })
      ]
    })
    expect(JSON.stringify(answer.context)).not.toContain('data:image')
    expect(selectAnswerVersion(answer, -1).content).toBe('Original explanation')
    expect(selectAnswerVersion(selectAnswerVersion(answer, -1), 1)).toMatchObject({
      content: 'Generated for: a red fox',
      imagePath: '/images/fox-2.png'
    })
    expect(withAnswerVersions(image, undefined)).toBe(image)
  })
})
