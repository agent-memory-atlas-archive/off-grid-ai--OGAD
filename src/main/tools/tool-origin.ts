import { findNativeToolSpec } from './nativeActionToolExtension-logic'

/** Set by the trusted request boundary, independently of browser tab metadata. */
export type ToolOrigin = 'desktop' | 'bridge'

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
