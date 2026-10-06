// The one place web_use picks its browser for a task: the user's default browser through the
// paired extension when Tasks > Web Use says so and it is connected, otherwise Off Grid AI's
// own browser. A task a paired browser started in one of its tabs runs in that browser and that
// tab (browser-start-tab.ts). Wiring only; the choice is web-use-target.ts (tested).

import { defaultBrowserTarget } from '../accessibility/ax-host'
import { getBrowserLinks } from '../extension-bridge/bridge-electron'
import { getWebUseSettings } from '../web-use-settings'
import { getBrowserRailHost } from './browser-host'
import type { BrowserRailHost } from './browser-rail'
import { startTabOffers } from './browser-start-tab'
import { createExtensionBrowserHost } from './extension-browser-host'
import { pickBrowserLink } from './web-use-target'

export function getWebUseRailHost(): BrowserRailHost {
  return {
    async runTask(request) {
      const { browserTarget } = getWebUseSettings()
      const links = getBrowserLinks()
      const offered = startTabOffers.take(request.journeyId)
      const offeredLink =
        offered && browserTarget === 'default_browser'
          ? links.find((l) => l.browser.id === offered.browserId)
          : undefined
      if (offered && offeredLink) {
        return createExtensionBrowserHost(() => offeredLink, offered.tabId).runTask(request)
      }
      const defaultName =
        browserTarget === 'default_browser' && links.length > 1
          ? ((await defaultBrowserTarget().catch(() => null))?.name ?? null)
          : null
      const link = pickBrowserLink(browserTarget, links, defaultName)
      return link
        ? createExtensionBrowserHost(() => link).runTask(request)
        : getBrowserRailHost().runTask(request)
    }
  }
}
