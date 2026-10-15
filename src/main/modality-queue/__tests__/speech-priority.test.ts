import { describe, expect, it } from 'vitest'
import { CAPTURE_JOB, CHAT_JOB, FOREGROUND_GRACE_MS, ModalityQueue, SPEECH_JOB } from '../queue'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A voice reply: the chat turn ends, then the renderer asks for its speech a moment later. A capture
 * pass that queued behind the chat must not take the GPU in that moment, nor while the voice is
 * being made (measured 2026-10-15: speech took 40-83 s instead of ~2.5 s when it did).
 */
describe('reading a reply aloud vs background passes', () => {
  it('speech asked for just after a chat turn runs before the queued capture pass, which waits for it', async () => {
    const queue = new ModalityQueue({ foregroundGraceMs: FOREGROUND_GRACE_MS })
    const events: string[] = []
    let finishChat!: () => void
    let finishSpeech!: () => void

    const chat = queue.run(CHAT_JOB, async () => {
      events.push('chat')
      await new Promise<void>((resolve) => (finishChat = resolve))
    })
    await wait(0)
    const capture = queue.run(CAPTURE_JOB, async () => {
      events.push('capture')
    })

    finishChat()
    await chat
    // The renderer's speech request lands a little after the turn's last token.
    await wait(200)
    expect(events).toEqual(['chat'])
    const speech = queue.run(SPEECH_JOB, async () => {
      events.push('speech')
      await new Promise<void>((resolve) => (finishSpeech = resolve))
    })
    await wait(0)
    expect(events).toEqual(['chat', 'speech'])

    // Past the grace period, the capture pass still waits while the voice is being made.
    await wait(FOREGROUND_GRACE_MS + 100)
    expect(events).toEqual(['chat', 'speech'])
    expect(queue.getState().queued.map((job) => job.label)).toEqual(['capture'])

    finishSpeech()
    await speech
    await wait(FOREGROUND_GRACE_MS + 100)
    await capture
    expect(events).toEqual(['chat', 'speech', 'capture'])
  }, 15_000)

  it('without foreground work, a background pass starts at once', async () => {
    const queue = new ModalityQueue({ foregroundGraceMs: FOREGROUND_GRACE_MS })
    const startedAt = Date.now()
    await queue.run(CAPTURE_JOB, async () => undefined)
    expect(Date.now() - startedAt).toBeLessThan(FOREGROUND_GRACE_MS)
  })
})
