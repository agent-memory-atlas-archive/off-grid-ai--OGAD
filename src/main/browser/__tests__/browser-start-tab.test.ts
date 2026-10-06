import { describe, expect, it } from 'vitest'
import { START_TAB_TTL_MS, createStartTabOffers } from '../browser-start-tab'

describe('the tab a browser offers for its web task', () => {
  it('is taken once, only by that journey, within the TTL', () => {
    let now = 1_000
    const offers = createStartTabOffers(() => now)
    offers.offer('browser:a', { browserId: 'a', tabId: 7 })

    expect(offers.take('browser:b')).toBeNull()
    expect(offers.take('browser:a')).toEqual({ browserId: 'a', tabId: 7 })
    expect(offers.take('browser:a')).toBeNull()

    offers.offer('browser:a', { browserId: 'a', tabId: 8 })
    now += START_TAB_TTL_MS + 1
    expect(offers.take('browser:a')).toBeNull()
  })

  it('a newer offer replaces the one waiting, and null withdraws it', () => {
    const offers = createStartTabOffers(() => 0)
    offers.offer('browser:a', { browserId: 'a', tabId: 7 })
    offers.offer('browser:a', { browserId: 'a', tabId: 9 })
    expect(offers.take('browser:a')).toEqual({ browserId: 'a', tabId: 9 })

    offers.offer('browser:a', { browserId: 'a', tabId: 7 })
    offers.offer('browser:a', null)
    expect(offers.take('browser:a')).toBeNull()
  })
})
