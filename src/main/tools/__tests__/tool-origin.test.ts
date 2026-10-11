import { describe, expect, it } from 'vitest'
import { isToolAllowedForOrigin, toolOriginOf, type ToolOrigin } from '../tool-origin'

const startTab = { browserId: 'chrome-1', tabId: 42 }

describe('tool context origin', () => {
  it.each<{
    label: string
    context?: { origin?: ToolOrigin; acting?: boolean; startTab?: unknown }
    origin?: ToolOrigin
    acting?: boolean
    webAllowed: boolean
    computerAllowed: boolean
  }>([
    { label: 'no context', webAllowed: true, computerAllowed: true },
    {
      label: 'desktop',
      context: { origin: 'desktop' },
      origin: 'desktop',
      webAllowed: true,
      computerAllowed: true
    },
    {
      label: 'bridge with acting false',
      context: { origin: 'bridge', acting: false },
      origin: 'bridge',
      acting: false,
      webAllowed: false,
      computerAllowed: false
    },
    {
      label: 'bridge with acting true',
      context: { origin: 'bridge', acting: true },
      origin: 'bridge',
      acting: true,
      webAllowed: true,
      computerAllowed: false
    },
    {
      label: 'startTab only',
      context: { startTab },
      origin: 'bridge',
      acting: true,
      webAllowed: true,
      computerAllowed: false
    },
    {
      label: 'startTab with acting false',
      context: { startTab, acting: false },
      origin: 'bridge',
      acting: false,
      webAllowed: false,
      computerAllowed: false
    },
    {
      label: 'bridge with startTab and no acting mode',
      context: { origin: 'bridge', startTab },
      origin: 'bridge',
      webAllowed: false,
      computerAllowed: false
    },
    {
      label: 'desktop with startTab',
      context: { origin: 'desktop', startTab },
      origin: 'bridge',
      acting: true,
      webAllowed: true,
      computerAllowed: false
    }
  ])('$label', ({ context, origin, acting, webAllowed, computerAllowed }) => {
    const resolved = toolOriginOf(context)
    expect(resolved).toEqual({ origin, acting })
    expect(isToolAllowedForOrigin('web_use', resolved.origin, resolved)).toBe(webAllowed)
    expect(isToolAllowedForOrigin('computer_use', resolved.origin, resolved)).toBe(computerAllowed)
  })
})
