// Whether a dead llama-server should be auto-restarted. Pure + electron-free so the
// rule is asserted directly; the close handler in llm.ts is otherwise unreachable by
// a unit test (it needs a real spawned process and electron's app paths).

export interface CrashRecoveryInput {
  /**
   * True while a freshly spawned engine is still being PROBED - from spawn until
   * waitForReady() confirms a loaded model.
   *
   * This is the field that fixes a real bug. `launchWithFallback` walks a ladder of
   * engines and contexts (Windows Vulkan -> Windows CPU; requested context -> smaller
   * -> CPU-only), and a probe that fails fast closes its process BEFORE waitForReady
   * notices. Treating that close as a crash meant auto-recovery raced the ladder that
   * was already handling it, and worse, `handleCrash` counted the probe in its rolling
   * restart window: the second failure inside 2 minutes HALVED ctxSize and PERSISTED
   * it. So a user whose GPU engine could not start silently lost half their configured
   * context. A launch-time failure is the ladder's business, never auto-recovery's.
   */
  probing: boolean
  /** Our own stop/swap asked for this exit. */
  wasIntentional: boolean
  /** Engine deliberately parked (e.g. image generation owns the memory). */
  paused: boolean
  /** Exit signal, if any. An external termination is recoverable; app stop intent is tracked separately. */
  signal: NodeJS.Signals | null
}

/** Recover an unexpected exit, including OS signals, only after a healthy launch. */
export function shouldAutoRecover(i: CrashRecoveryInput): boolean {
  if (i.probing) return false
  if (i.wasIntentional || i.paused) return false
  return true
}
