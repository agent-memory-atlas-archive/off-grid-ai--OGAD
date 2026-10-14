import { describe, expect, it } from 'vitest'
import { forgetModelReads, shortLivedRead } from '../bridge-model-reads'

describe('shortLivedRead', () => {
  it('shares one read across polls inside the window and reads again after it', async () => {
    let clock = 0
    let reads = 0
    const read = shortLivedRead(
      async () => ++reads,
      () => clock
    )
    expect(await Promise.all([read(), read(), read()])).toEqual([1, 1, 1])
    clock = 2_999
    expect(await read()).toBe(1)
    clock = 3_000
    expect(await read()).toBe(2)
  })

  it('reads again after a model change clears the cache', async () => {
    let reads = 0
    const read = shortLivedRead(
      async () => ++reads,
      () => 0
    )
    await read()
    forgetModelReads()
    expect(await read()).toBe(2)
  })

  it('does not keep a failed read', async () => {
    let attempt = 0
    const read = shortLivedRead(
      async () => {
        attempt += 1
        if (attempt === 1) throw new Error('disk busy')
        return attempt
      },
      () => 0
    )
    await expect(read()).rejects.toThrow('disk busy')
    expect(await read()).toBe(2)
  })
})
