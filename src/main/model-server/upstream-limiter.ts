// Admission for one upstream runtime in team mode: up to `capacity` requests run at once, the rest
// wait in arrival order up to a bound, and the overflow is refused (the gateway answers 429). A
// waiter whose client goes away leaves the queue. `exclusive` runs work that needs the runtime to
// itself (a model swap, an eviction): new requests wait, running ones finish first.
//
// The decisions (run / queue / refuse, who may start) are the shared pure policy; this file only
// holds the waiters and wakes them.

import {
  limiterAdmission,
  limiterCanStart,
  limiterQueueDepth,
  LIMITER_RETRY_AFTER_SECONDS
} from '@offgrid/models'

/** The queue is full: the client should retry after `retryAfterSeconds`. */
export class LimiterFullError extends Error {
  readonly status = 429
  readonly retryAfterSeconds = LIMITER_RETRY_AFTER_SECONDS
  constructor(readonly runtime: string) {
    super(`The ${runtime} runtime is busy. Try again shortly.`)
    this.name = 'LimiterFullError'
  }
}

interface Waiter {
  tokens: number
  start: () => void
  reject: (reason: unknown) => void
}

export type Release = () => void

export class UpstreamLimiter {
  private active = 0
  private activeTokens = 0
  /** llama-server's KV pool in tokens: running requests may not expect more, together. */
  private tokenBudget: number | undefined
  private readonly waiting: Waiter[] = []
  private exclusiveDepth = 0
  private exclusiveChain: Promise<unknown> = Promise.resolve()
  private idleWaiters: (() => void)[] = []

  constructor(
    readonly runtime: string,
    private capacity: number
  ) {}

  /** Follow the runtime's current slot count (it changes with the gateway mode). */
  setCapacity(capacity: number): void {
    if (capacity === this.capacity) return
    this.capacity = Math.max(1, capacity)
    this.pump()
  }

  /** Admit by tokens as well as by count (the chat model's unified KV pool). */
  setTokenBudget(tokens: number | undefined): void {
    if (tokens === this.tokenBudget) return
    this.tokenBudget = tokens
    this.pump()
  }

  get inFlight(): number {
    return this.active
  }

  get queued(): number {
    return this.waiting.length
  }

  /** Wait for a turn. Resolves with the release to call when the request ends (idempotent). */
  acquire(signal?: AbortSignal, tokens = 0): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
    const decision = limiterAdmission({
      active: this.active,
      queued: this.waiting.length,
      capacity: this.capacity,
      maxQueued: limiterQueueDepth(this.capacity),
      exclusive: this.exclusiveDepth > 0,
      tokenBudget: this.tokenBudget,
      activeTokens: this.activeTokens,
      requestTokens: tokens
    })
    if (decision === 'reject') return Promise.reject(new LimiterFullError(this.runtime))
    if (decision === 'run') return Promise.resolve(this.take(tokens))
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        tokens,
        start: () => {
          signal?.removeEventListener('abort', onAbort)
          resolve(this.take(tokens))
        },
        reject
      }
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal?.reason ?? new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  /** Run `fn` with the runtime to itself: no new request starts, running ones finish first. With
   *  `maxWaitMs`, `fn` runs once that has passed even if some are still running (a relaunch for
   *  changed settings must happen; a stuck stream must not hold it off for ever). */
  exclusive<T>(fn: () => Promise<T>, maxWaitMs?: number): Promise<T> {
    const run = this.exclusiveChain.then(async () => {
      this.exclusiveDepth += 1
      try {
        await this.idle(maxWaitMs)
        return await fn()
      } finally {
        this.exclusiveDepth -= 1
        this.pump()
      }
    })
    this.exclusiveChain = run.catch(() => {})
    return run
  }

  private idle(maxWaitMs?: number): Promise<void> {
    if (this.active === 0) return Promise.resolve()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const wake = (): void => {
        if (timer) clearTimeout(timer)
        resolve()
      }
      this.idleWaiters.push(wake)
      if (maxWaitMs !== undefined)
        timer = setTimeout(() => {
          this.idleWaiters = this.idleWaiters.filter((waiter) => waiter !== wake)
          resolve()
        }, maxWaitMs)
    })
  }

  private take(tokens: number): Release {
    this.active += 1
    this.activeTokens += tokens
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.activeTokens -= tokens
      if (this.active === 0) {
        const waiters = this.idleWaiters
        this.idleWaiters = []
        for (const wake of waiters) wake()
      }
      this.pump()
    }
  }

  private pump(): void {
    while (
      this.waiting.length > 0 &&
      limiterCanStart({
        active: this.active,
        capacity: this.capacity,
        exclusive: this.exclusiveDepth > 0,
        tokenBudget: this.tokenBudget,
        activeTokens: this.activeTokens,
        requestTokens: this.waiting[0]!.tokens
      })
    ) {
      this.waiting.shift()!.start()
    }
  }
}
