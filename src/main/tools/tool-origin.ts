import { findNativeToolSpec } from './nativeActionToolExtension-logic'

/** Set by the trusted request boundary, independently of browser tab metadata. */
export type ToolOrigin = 'desktop' | 'bridge'

export const PAIRED_BROWSER_COMPUTER_USE_REFUSAL =
  'This request belongs to a paired browser tab. Use web_use for this task; it retains that tab and its login.'

export function toolOriginOf(context?: {
  origin?: ToolOrigin
  acting?: boolean
  startTab?: unknown
}): { origin?: ToolOrigin; acting?: boolean } {
  if (context?.origin === 'bridge') return { origin: 'bridge', acting: context.acting }
  // A startTab comes only from a paired browser agent task; preserve any explicit acting mode.
  if (context?.startTab != null) return { origin: 'bridge', acting: context.acting ?? true }
  return { origin: context?.origin, acting: context?.acting }
}

/** Bridge chat may read tools; only an explicit acting request may change an app or page. */
export function isToolAllowedForOrigin(
  name: unknown,
  origin?: ToolOrigin,
  options: { acting?: boolean } = {}
): boolean {
  if (origin !== 'bridge') return true
  if (name === 'computer_use') return false
  const spec = typeof name === 'string' ? findNativeToolSpec(name) : undefined
  return !spec || spec.risk === 'read' || options.acting === true
}
