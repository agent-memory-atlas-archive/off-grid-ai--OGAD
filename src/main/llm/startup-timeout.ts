/**
 * How long a starting llama-server may stay silent before we treat it as stuck.
 * There is no total deadline: a large model on a slow disk keeps printing load progress and
 * gets all the time it needs, and an engine that crashes fails at once. Only a server that
 * stops writing anything is abandoned, so the next engine can try. CUDA and CLIP setup can sit
 * quiet for over a minute on a cold device, so CUDA engines get longer.
 */
export function modelStartupQuietLimit(engineName: string): number {
  return engineName.endsWith('-cuda') ? 180_000 : 60_000
}

/** True when the server has written nothing for longer than `quietLimit`. */
export function startupStalled(now: number, lastOutputAt: number, quietLimit: number): boolean {
  return now - lastOutputAt > quietLimit
}
