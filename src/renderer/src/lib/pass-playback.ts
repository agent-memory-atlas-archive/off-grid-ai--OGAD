/**
 * Plays a spoken reply while it is still being made.
 *
 * Long replies are synthesized in passes (the speech engine reads only so much at once). The first
 * pass is one sentence, so it is ready long before the whole clip: this plays the passes in order
 * as they arrive, and once the joined clip arrives it moves onto it at the next pass boundary, where
 * the two are sample-identical, so seeking and the duration work on one clip from then on.
 *
 * It exposes the part of HTMLAudioElement the voice player uses, so the player drives a finished
 * clip and a clip still being made the same way.
 */

/** What the voice player needs from a clip. HTMLAudioElement already is one. */
export interface PlayableClip {
  currentTime: number
  readonly duration: number
  readonly paused: boolean
  playbackRate: number
  ontimeupdate: ((this: GlobalEventHandlers, ev: Event) => unknown) | null
  onloadedmetadata: ((this: GlobalEventHandlers, ev: Event) => unknown) | null
  onended: ((this: GlobalEventHandlers, ev: Event) => unknown) | null
  onerror: OnErrorEventHandler
  play(): Promise<void>
  pause(): void
}

type Handler = ((this: GlobalEventHandlers, ev: Event) => unknown) | null

export class PassPlayback implements PlayableClip {
  ontimeupdate: Handler = null
  onloadedmetadata: Handler = null
  onended: Handler = null
  onerror: OnErrorEventHandler = null

  /** Indexed by pass; a slot stays empty until that pass arrives. */
  private readonly passes: (HTMLAudioElement | undefined)[] = []
  private full: HTMLAudioElement | null = null
  private current: HTMLAudioElement | null = null
  /** Where `current` starts within the whole reply, in seconds (0 once on the joined clip). */
  private offset = 0
  private currentIndex = -1
  private wantsPlay = false
  /** A pass ended before the next one (or the joined clip) arrived. */
  private stalled = false
  private rate = 1
  /** A seek made before any audio existed. */
  private pendingSeek = 0
  private firstAudio: (() => void) | null = null

  constructor(
    private readonly createAudio: (src: string) => HTMLAudioElement = (src) => new Audio(src)
  ) {}

  /** Pass `index` of the reply is ready. */
  addPass(index: number, dataUrl: string): void {
    if (this.full) return
    const audio = this.prepare(dataUrl)
    audio.onended = () => this.passEnded(index)
    this.passes[index] = audio
    if (!this.current && index === 0) this.enter(audio, 0, 0, this.pendingSeek)
    else if (this.stalled && index === this.currentIndex + 1) this.advance()
  }

  /** The joined clip is ready: everything plays from it after the current pass. */
  setFull(dataUrl: string): void {
    const full = this.prepare(dataUrl)
    full.onloadedmetadata = (event) => this.onloadedmetadata?.call(full, event)
    full.onended = (event) => {
      this.wantsPlay = false
      this.onended?.call(full, event)
    }
    this.full = full
    // No pass yet (a one-pass reply), or waiting at a boundary: move now.
    if (!this.current) this.enter(full, 0, -1, this.pendingSeek)
    else if (this.stalled) this.enter(full, 0, -1, this.passEndOffset(this.currentIndex))
  }

  get currentTime(): number {
    return this.current ? this.offset + this.current.currentTime : this.pendingSeek
  }

  set currentTime(seconds: number) {
    if (!this.current) {
      this.pendingSeek = Math.max(0, seconds)
      return
    }
    if (this.full) {
      this.enter(this.full, 0, -1, seconds)
      return
    }
    // Before the joined clip: the passes whose length is known so far.
    let start = 0
    for (const [index, pass] of this.passes.entries()) {
      const length = pass && Number.isFinite(pass.duration) ? pass.duration : 0
      if (!pass || seconds < start + length || index === this.passes.length - 1) {
        if (pass) this.enter(pass, start, index, Math.max(0, Math.min(seconds - start, length)))
        return
      }
      start += length
    }
  }

  get duration(): number {
    return this.full?.duration ?? Number.NaN
  }

  get paused(): boolean {
    return !this.wantsPlay
  }

  get playbackRate(): number {
    return this.rate
  }

  set playbackRate(rate: number) {
    this.rate = rate
    if (this.current) this.current.playbackRate = rate
  }

  /** Resolves once audio is actually playing (after the first pass arrives, if none has). */
  async play(): Promise<void> {
    this.wantsPlay = true
    if (!this.current) {
      await new Promise<void>((resolve) => (this.firstAudio = resolve))
    }
    // `paused`, not the field: pause() may have run while this waited for the first audio.
    if (!this.paused && this.current && !this.stalled) await this.current.play()
  }

  pause(): void {
    this.wantsPlay = false
    this.current?.pause()
  }

  private prepare(dataUrl: string): HTMLAudioElement {
    const audio = this.createAudio(dataUrl)
    audio.preload = 'auto'
    audio.onerror = (event) => this.onerror?.call(audio as never, event)
    return audio
  }

  private enter(audio: HTMLAudioElement, offset: number, index: number, at: number): void {
    const wasPlaying = this.wantsPlay
    if (this.current && this.current !== audio) {
      this.current.pause()
      this.current.ontimeupdate = null
    }
    this.current = audio
    this.offset = offset
    this.currentIndex = index
    this.stalled = false
    audio.playbackRate = this.rate
    audio.ontimeupdate = (event) => this.ontimeupdate?.call(audio, event)
    audio.currentTime = at
    if (this.firstAudio) {
      const resolve = this.firstAudio
      this.firstAudio = null
      resolve()
    } else if (wasPlaying) void audio.play().catch(() => {})
  }

  /** Where pass `index` ends within the reply. */
  private passEndOffset(index: number): number {
    let end = 0
    for (let i = 0; i <= index; i++) end += this.passes[i]?.duration ?? 0
    return end
  }

  private passEnded(index: number): void {
    if (index !== this.currentIndex) return
    if (this.full) {
      this.enter(this.full, 0, -1, this.passEndOffset(index))
      return
    }
    if (this.passes[index + 1]) {
      this.advance()
      return
    }
    // The next pass is still being made: wait at the boundary.
    this.stalled = true
  }

  private advance(): void {
    const next = this.currentIndex + 1
    const pass = this.passes[next]
    if (pass) this.enter(pass, this.passEndOffset(this.currentIndex), next, 0)
  }
}
