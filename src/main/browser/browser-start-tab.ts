// The browser tab a paired browser offered for the web task it is asking for: the chat's tab,
// so the task works where the user is. Mirrors the extension's start-tab.ts, whose fence lets
// the desktop take that one tab (socket op tab.adopt), once, within a minute.
//
// Keyed by the task's journey (the browser's `${BROWSER_ORIGIN_PREFIX}${browser.id}`), so only
// a web task that browser started can take it. Pure; the process-wide instance is below.

export const START_TAB_TTL_MS = 60_000

export interface StartTab {
  /** The paired browser whose tab this is: the task must run over that browser's link. */
  readonly browserId: string
  readonly tabId: number
}

export interface StartTabOffers {
  /** Offer `tab` for the journey's next web task; null withdraws any offer waiting. */
  offer(journeyId: string, tab: StartTab | null): void
  /** The offered tab, taken once; null when none is waiting or it is older than the TTL. */
  take(journeyId: string): StartTab | null
}

export function createStartTabOffers(now: () => number): StartTabOffers {
  const waiting = new Map<string, { tab: StartTab; at: number }>()
  return {
    offer(journeyId, tab) {
      if (tab) waiting.set(journeyId, { tab, at: now() })
      else waiting.delete(journeyId)
    },
    take(journeyId) {
      const offer = waiting.get(journeyId)
      waiting.delete(journeyId)
      return offer && now() - offer.at <= START_TAB_TTL_MS ? offer.tab : null
    }
  }
}

/** The offers the extension bridge makes and web_use takes, for this process. */
export const startTabOffers: StartTabOffers = createStartTabOffers(Date.now)
