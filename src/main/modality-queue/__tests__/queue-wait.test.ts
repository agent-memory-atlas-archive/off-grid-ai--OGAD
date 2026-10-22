import { describe, expect, it } from 'vitest'
import { ModalityQueue } from '../queue'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('a job waiting its turn', () => {
  it('hears how many jobs are before it, and never counts itself once admitted', async () => {
    const q = new ModalityQueue()
    let releaseFirst!: () => void
    const first = q.run({ tier: 2, label: 'a' }, () => new Promise<void>((r) => (releaseFirst = r)))
    const firstWaits: number[] = []
    const secondWaits: number[] = []
    let releaseSecond!: () => void
    const second = q.run(
      { tier: 2, label: 'b', onWait: (ahead) => secondWaits.push(ahead) },
      () => new Promise<void>((r) => (releaseSecond = r))
    )
    const third = q.run(
      { tier: 2, label: 'c', onWait: (ahead) => firstWaits.push(ahead) },
      async () => {}
    )
    await tick()
    expect(secondWaits.at(-1)).toBe(1)
    expect(firstWaits.at(-1)).toBe(2)

    releaseFirst()
    await first
    await tick()
    const heardBySecond = secondWaits.length
    expect(firstWaits.at(-1)).toBe(1)
    releaseSecond()
    await Promise.all([second, third])
    // Once running, the second job hears nothing more.
    expect(secondWaits).toHaveLength(heardBySecond)
  })
})
