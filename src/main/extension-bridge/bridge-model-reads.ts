// The extension polls settings and the model inventory several times a second. Each read
// rebuilds the model catalog from disk on the main thread (folder walks, realpath per
// file, GGUF metadata), which beachballed the app. Reads share one result for a few
// seconds and one in-flight call; a model change made through the bridge clears them.

const TTL_MS = 3_000

type Read<T> = () => Promise<T>

const cached = new Set<{ clear(): void }>()

/** Wrap `read` so callers within `TTL_MS` share its result and its in-flight promise. */
export function shortLivedRead<T>(read: Read<T>, now: () => number = Date.now): Read<T> {
  let last: { at: number; value: Promise<T> } | null = null
  cached.add({
    clear: () => {
      last = null
    }
  })
  return () => {
    if (last && now() - last.at < TTL_MS) return last.value
    const value = read()
    const entry = { at: now(), value }
    last = entry
    value.catch(() => {
      if (last === entry) last = null
    })
    return value
  }
}

/** Forget every cached read, e.g. after the extension activates a model. */
export function forgetModelReads(): void {
  for (const entry of cached) entry.clear()
}
