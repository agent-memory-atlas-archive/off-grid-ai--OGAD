import { describe, expect, it } from 'vitest'
import { runChatWithFallback } from '../chat-fallback'
import { runWithChatModel } from '../llm/chat-model-scope'

describe('a chat turn on its own model', () => {
  it('fails as that model and never switches to another', async () => {
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
            throw new Error(
              'Remote text model connection failed: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT).'
            )
          },
          { onModelChanged: (failed, next) => changes.push(`${failed} -> ${next}`) }
        )
    )

    await expect(turn).rejects.toThrow('Headers Timeout Error')
    expect(changes).toEqual([])
    expect(attempts).toBeGreaterThanOrEqual(1)
  })
})
