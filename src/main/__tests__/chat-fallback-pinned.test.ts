import { describe, expect, it } from 'vitest'
import { runChatWithFallback } from '../chat-fallback'
import { runWithChatModel } from '../llm/chat-model-scope'

const timeout = (): Error =>
  new Error('Remote text model connection failed: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT).')

describe('a chat turn whose model cannot answer', () => {
  it('fails as that model and never switches a pane to another', async () => {
    const changes: string[] = []
    let attempts = 0
    const turn = runWithChatModel(
      {
        id: 'pod',
        name: 'RTX Pro 6000',
        provider: 'custom',
        endpoint: 'http://127.0.0.1:1/v1',
        model: 'flint',
        apiKey: ''
      },
      () =>
        runChatWithFallback(
          async () => {
            attempts++
            throw timeout()
          },
          { onModelChanged: (failed, next) => changes.push(`${failed} -> ${next}`) }
        )
    )

    await expect(turn).rejects.toThrow('Headers Timeout Error')
    expect(changes).toEqual([])
    expect(attempts).toBeGreaterThanOrEqual(1)
  })

  it('fails as the app-wide model too, instead of switching the whole app to another', async () => {
    const changes: string[] = []
    const turn = runChatWithFallback(
      async () => {
        throw timeout()
      },
      { onModelChanged: (failed, next) => changes.push(`${failed} -> ${next}`) }
    )

    await expect(turn).rejects.toThrow('Headers Timeout Error')
    expect(changes).toEqual([])
  })
})
