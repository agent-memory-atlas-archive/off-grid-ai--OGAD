import { useEffect, useState } from 'react'

interface MediaBridge {
  getMediaUrl?: (absPath: string) => Promise<string | null>
}

export type MediaUrlState =
  | { status: 'idle' | 'loading' | 'missing'; url: null }
  | { status: 'ready'; url: string }

interface ResolvedMediaUrl {
  path: string
  url: string | null
}

function bridge(): MediaBridge | undefined {
  return (window as unknown as { api?: MediaBridge }).api
}

/**
 * Resolve an owned local path through the main process's tokenized HTTP server.
 *
 * `enabled` lets a list resolve media for the rows a person can actually see. A library of five
 * hundred recordings used to resolve five hundred URLs and mount five hundred players on first
 * paint, for a screen showing a dozen.
 */
export function useMediaUrl(absPath: string | null | undefined, enabled = true): MediaUrlState {
  const [resolved, setResolved] = useState<ResolvedMediaUrl | null>(null)
  const resolveMediaUrl = bridge()?.getMediaUrl

  useEffect(() => {
    let live = true
    if (!absPath || !resolveMediaUrl || !enabled) return () => undefined

    void resolveMediaUrl(absPath)
      .then((url) => {
        if (!live) return
        setResolved({ path: absPath, url })
      })
      .catch(() => {
        if (live) setResolved({ path: absPath, url: null })
      })
    return () => {
      live = false
    }
  }, [absPath, resolveMediaUrl, enabled])

  if (!absPath || !enabled) return { status: 'idle', url: null }
  if (!resolveMediaUrl) return { status: 'missing', url: null }
  if (resolved?.path !== absPath) return { status: 'loading', url: null }
  return resolved.url ? { status: 'ready', url: resolved.url } : { status: 'missing', url: null }
}
