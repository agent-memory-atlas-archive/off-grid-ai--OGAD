/**
 * Guards when a dead llama-server is auto-restarted.
 *
 * The motivating bug, found while fixing GPU offload on Windows: the Vulkan engine
 * failed at startup and closed its process within a second - before waitForReady()
 * could mark it abandoned - so the close handler ran the CRASH path on what was
 * really a failed launch. Two consequences, both silent:
 *   1. handleCrash re-entered init() and raced the engine ladder already walking to
 *      the CPU build.
 *   2. The probe counted toward handleCrash's rolling restart window, and the second
 *      failure inside 2 minutes halved ctxSize and PERSISTED it - so a user whose GPU
 *      engine could not start quietly lost half their configured context.
 */
import { describe, it, expect } from 'vitest'
import { shouldAutoRecover, type CrashRecoveryInput } from '../crash-policy'

/** A genuine crash of a healthy engine: the one recoverable case. */
const HEALTHY_CRASH: CrashRecoveryInput = {
  probing: false,
  wasIntentional: false,
  paused: false,
  signal: null
}

describe('shouldAutoRecover', () => {
  it('recovers a genuine crash of an engine that was already healthy', () => {
    expect(shouldAutoRecover(HEALTHY_CRASH)).toBe(true)
  })

  it('recovers an abort (SIGABRT is not a deliberate stop)', () => {
    expect(shouldAutoRecover({ ...HEALTHY_CRASH, signal: 'SIGABRT' })).toBe(true)
  })

  describe('a failed LAUNCH is never a crash (the reported bug)', () => {
    it('does not recover while the engine is still being probed', () => {
      expect(shouldAutoRecover({ ...HEALTHY_CRASH, probing: true })).toBe(false)
    })

    // The regression that halved and persisted ctxSize. A fast-failing engine closes
    // before waitForReady's catch runs, so `probing` is the ONLY signal available at
    // close time that distinguishes a launch failure from a crash. If this flips true,
    // handleCrash starts counting probes again and the context-halving returns.
    it('does not recover a probe that fails fast with a non-zero exit and no signal', () => {
      expect(
        shouldAutoRecover({ probing: true, wasIntentional: false, paused: false, signal: null })
      ).toBe(false)
    })

    it('stays false while probing even if nothing else looks deliberate', () => {
      for (const signal of [null, 'SIGABRT'] as const) {
        expect(shouldAutoRecover({ ...HEALTHY_CRASH, probing: true, signal })).toBe(false)
      }
    })
  })

  describe('deliberate stops stay dead', () => {
    // External termination recovers; explicit app stops and memory pauses do not.
    it('recovers an external SIGKILL', () => {
      expect(shouldAutoRecover({ ...HEALTHY_CRASH, signal: 'SIGKILL' })).toBe(true)
    })

    it('recovers an external SIGTERM', () => {
      expect(shouldAutoRecover({ ...HEALTHY_CRASH, signal: 'SIGTERM' })).toBe(true)
    })

    it('does not recover our own stop/swap', () => {
      expect(shouldAutoRecover({ ...HEALTHY_CRASH, wasIntentional: true })).toBe(false)
    })

    it('does not recover while the engine is parked for image generation', () => {
      expect(shouldAutoRecover({ ...HEALTHY_CRASH, paused: true })).toBe(false)
    })
  })

  it('treats probing as decisive even when a deliberate reason also applies', () => {
    expect(
      shouldAutoRecover({ probing: true, wasIntentional: true, paused: true, signal: 'SIGKILL' })
    ).toBe(false)
  })
})
