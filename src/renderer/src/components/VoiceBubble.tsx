/**
 * VoiceBubble — desktop voice-note bubble for the chat's voice mode.
 *
 * A WhatsApp-style audio message: play/pause, a 48-bar waveform that tints as
 * the playhead passes, click-to-seek, a duration readout, a speed chip, and a
 * "Show transcript" toggle. Ported from the mobile app's AudioMessageBubble so
 * both products behave identically.
 *
 *  - User voice notes carry a recorded clip (`audioUrl`) → we decode its REAL
 *    envelope and play the file directly.
 *  - Assistant replies have no file → we synthesize on-device (Kokoro) the first
 *    time Play is pressed, cache the result, and draw a deterministic
 *    transcript-derived envelope (stable before/during playback).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Play,
  Pause,
  Copy,
  ArrowsClockwise,
  Check,
  Subtitles,
  SubtitlesSlash
} from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { ToggleGroup, ToggleGroupItem } from '@offgrid/operator-ui/operator/coss/toggle-group'
import { Waveform } from '@offgrid/operator-ui/operator/elevenlabs/waveform'
import {
  Transcription,
  TranscriptionSegment
} from '@offgrid/operator-ui/operator/elements/transcription'
import { AutoHeight } from '@offgrid/operator-ui/operator/presence'
import { claimVoicePlayback, onVoicePlaybackClaim } from '@renderer/lib/voice-playback-bus'
import { LoadingDots } from './ui/loading-dots'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

const WAVEFORM_BARS = 48
const SPEED_STEPS = [0.5, 0.8, 1.0, 1.25, 1.5, 2.0]
/** Arrow keys move the playhead by this share of the clip. */
const SEEK_STEP = 0.05
const ease = [0.16, 1, 0.3, 1] as const

interface TimedSegment {
  text: string
  startSecond: number
  endSecond: number
}

/**
 * The transcript as sentences laid along the clip. Speech has no word timings here, so each
 * sentence takes the share of the duration its length takes of the text: close enough for the
 * words to follow the playhead and for a click on a sentence to land near it.
 */
function timedSegments(text: string, duration: number): TimedSegment[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim())
  const total = sentences.reduce((sum, sentence) => sum + sentence.length, 0) || 1
  let at = 0
  return sentences.map((sentence) => {
    const startSecond = (at / total) * duration
    at += sentence.length
    return { text: sentence.trim(), startSecond, endSecond: (at / total) * duration }
  })
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Deterministic, speech-like envelope derived from the transcript (port of the
 *  mobile waveformFromText). Same text → same bars, so it's stable mid-playback. */
function waveformFromText(text: string, points: number): number[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length === 0 || points <= 0) return Array.from({ length: points }, () => 0)
  const out: number[] = []
  for (let i = 0; i < points; i++) {
    const idx = Math.min(clean.length - 1, Math.floor((i / points) * clean.length))
    const ch = clean[idx]!
    const code = clean.charCodeAt(idx)
    let base: number
    if (ch === ' ') base = 0.12
    else if (/[.,!?;:]/.test(ch)) base = 0.1
    else if (/[aeiouAEIOU]/.test(ch)) base = 0.85
    else base = 0.45
    const ripple = 0.18 * (1 + Math.sin(idx * 1.7 + (code % 7))) * 0.5
    out.push(Math.min(1, base + ripple))
  }
  return out
}

function subsample(data: number[], count: number): number[] {
  if (data.length === 0) return Array.from({ length: count }, () => 0)
  const step = data.length / count
  const result: number[] = []
  for (let i = 0; i < count; i++) result.push(data[Math.floor(i * step)] ?? 0)
  return result
}

function normalize(data: number[]): number[] {
  const max = Math.max(...data, 0.001)
  return data.map((v) => v / max)
}

/** One empty envelope, so the derived value keeps its identity between renders. */
const NO_DECODED_WAVE: number[] = []

/**
 * How long the clip is and how far through it we are.
 *
 * The real duration once the audio element reports one, the estimate until then, and a fraction
 * that cannot exceed 1 - clamped because `currentTime` can pass an ESTIMATED duration, and a
 * progress bar past its own end is a visible glitch. Pure, and out here so the component does not
 * carry the branches.
 */
function playbackProgress(input: {
  readonly loadedDuration: number
  readonly estDuration: number
  readonly currentTime: number
}): { totalDuration: number; progress: number } {
  const totalDuration = input.loadedDuration || input.estDuration
  const progress = totalDuration ? Math.min(1, input.currentTime / totalDuration) : 0
  return { totalDuration, progress }
}

/** A decoded envelope, and the clip it was decoded from. */
interface DecodedWave {
  readonly url: string
  readonly wave: number[]
}

/**
 * The envelope that belongs to THIS clip, or none.
 *
 * Derived rather than kept in sync, and derived out here so the component's own complexity does not
 * pay for it: a decoded wave is only this clip's wave if it was decoded from this clip's url.
 */
function waveForClip(audioUrl: string | undefined, decoded: DecodedWave | null): number[] {
  if (!audioUrl || decoded?.url !== audioUrl) return NO_DECODED_WAVE
  return decoded.wave
}

/** Decode a real audio file's envelope once (recordings). */
async function decodeFileWaveform(url: string, points: number): Promise<number[]> {
  try {
    const res = await fetch(url)
    const buf = await res.arrayBuffer()
    const Ctx = window.AudioContext
    const ctx = new Ctx()
    const audio = await ctx.decodeAudioData(buf)
    const ch = audio.getChannelData(0)
    const block = Math.floor(ch.length / points) || 1
    const out: number[] = []
    for (let i = 0; i < points; i++) {
      let sum = 0
      for (let j = 0; j < block; j++) sum += Math.abs(ch[i * block + j] ?? 0)
      out.push(sum / block)
    }
    void ctx.close()
    return out
  } catch {
    return []
  }
}

interface VoiceBubbleProps {
  messageId: string
  /** Recorded clip URL for user voice notes; absent for assistant replies. */
  audioUrl?: string
  durationSeconds?: number
  transcript: string
  isUser?: boolean
  /** Assistant reply still generating — shows pulsing dots, no playback. */
  isLoading?: boolean
  /** Synthesize text → playable dataUrl on-device (assistant replies). */
  synthesize: (text: string, voice?: string) => Promise<{ dataUrl: string }>
  /** Read the selected voice before playing a synthesized reply. */
  readVoice?: () => Promise<string | undefined>
  /** Play once automatically when ready (a just-finished assistant reply). */
  autoPlay?: boolean
  /** The latest assistant voice reply opens its transcript without another click. */
  showTranscriptInitially?: boolean
  /** Persisted playback speed from Voice settings. */
  defaultSpeed?: number
  /** Use the parent message bubble for width, color, border, and padding. */
  embedded?: boolean
  /** Reports audio preparation and playback so hands-free input cannot record the reply. */
  onPlaybackStateChange?: (active: boolean) => void
  /** The chat's existing copy-feedback state for this message. */
  copied?: boolean
  onCopy?: (text: string) => void
  onRetry?: () => void
}

export const VoiceBubble: React.FC<VoiceBubbleProps> = ({
  messageId,
  audioUrl,
  durationSeconds,
  transcript,
  isUser = false,
  isLoading = false,
  synthesize,
  readVoice,
  autoPlay = false,
  showTranscriptInitially = false,
  defaultSpeed = 1,
  embedded = false,
  onPlaybackStateChange,
  copied = false,
  onCopy,
  onRetry
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const srcRef = useRef<{ dataUrl: string; voice?: string } | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle')
  const [currentTime, setCurrentTime] = useState(0)
  const [loadedDuration, setLoadedDuration] = useState(0)
  const [speed, setSpeed] = useState(defaultSpeed)
  /**
   * The persisted speed preference changed, so the chip goes back to it.
   *
   * React's "adjusting state when a prop changes": compare against the PREVIOUS prop value during
   * render, rather than copying the prop into state from an effect. It fires on exactly the
   * transitions the effect did - once per change of `defaultSpeed`, including a change back to a
   * value the user had once overridden - and it does it before anything renders with the stale
   * value instead of after a second pass.
   */
  const [appliedDefaultSpeed, setAppliedDefaultSpeed] = useState(defaultSpeed)
  if (appliedDefaultSpeed !== defaultSpeed) {
    setAppliedDefaultSpeed(defaultSpeed)
    setSpeed(defaultSpeed)
  }
  const [showTranscript, setShowTranscript] = useState(showTranscriptInitially)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const playbackActive = status === 'loading' || status === 'playing'

  useEffect(() => {
    if (showTranscriptInitially && transcript && !isLoading) setShowTranscript(true)
  }, [isLoading, showTranscriptInitially, transcript])

  // Telling the audio element about a new preference IS updating an external system, which is what
  // an effect is for. Resetting the chip is not - see `chosenSpeed`.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = defaultSpeed
  }, [defaultSpeed])

  useEffect(() => {
    onPlaybackStateChange?.(playbackActive)
    return () => {
      if (playbackActive) onPlaybackStateChange?.(false)
    }
  }, [onPlaybackStateChange, playbackActive])

  /**
   * Stable waveform: the real decoded envelope for a recording, else transcript-derived.
   *
   * The decoded envelope is stored WITH the clip it came from, so "which wave belongs to this
   * clip" is derived rather than kept in sync by clearing state in an effect. That also closes a
   * real gap: the old effect only cleared on no clip at all, so between one clip's url changing
   * and the new one finishing decoding, the bubble drew the PREVIOUS recording's envelope. It now
   * falls back to the transcript-derived shape for that window, which is what it already does
   * before any clip has decoded.
   */
  const [decodedWave, setDecodedWave] = useState<DecodedWave | null>(null)
  useEffect(() => {
    if (!audioUrl) return
    let cancelled = false
    void decodeFileWaveform(audioUrl, WAVEFORM_BARS).then((wave) => {
      if (!cancelled) setDecodedWave({ url: audioUrl, wave })
    })
    return () => {
      cancelled = true
    }
  }, [audioUrl])
  const fileWave = waveForClip(audioUrl, decodedWave)

  const bars = useMemo(() => {
    const raw = fileWave.length ? fileWave : waveformFromText(transcript, WAVEFORM_BARS)
    return normalize(subsample(raw, WAVEFORM_BARS))
  }, [fileWave, transcript])

  // Estimate duration before the audio element reports a real value.
  const estDuration = useMemo(() => {
    if (durationSeconds) return durationSeconds
    const words = transcript.trim().split(/\s+/).filter(Boolean).length
    return Math.max(1, words / (2.5 * speed))
  }, [durationSeconds, transcript, speed])
  const { totalDuration, progress } = playbackProgress({ loadedDuration, estDuration, currentTime })
  const segments = useMemo(
    () => timedSegments(transcript, totalDuration),
    [transcript, totalDuration]
  )
  const reduceMotion = useReducedMotion()
  const scrubbing = useRef(false)

  // Pause when another bubble takes over playback.
  useEffect(() => {
    return onVoicePlaybackClaim((id) => {
      if (id !== messageId && audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause()
        setStatus('paused')
      }
    })
  }, [messageId])

  useEffect(
    () => () => {
      audioRef.current?.pause()
      audioRef.current = null
    },
    []
  )

  const wire = useCallback(
    (audio: HTMLAudioElement) => {
      audio.playbackRate = speed
      audio.ontimeupdate = () => setCurrentTime(audio.currentTime)
      audio.onloadedmetadata = () => {
        if (Number.isFinite(audio.duration)) setLoadedDuration(audio.duration)
      }
      audio.onended = () => {
        setStatus('idle')
        setCurrentTime(0)
      }
      audio.onerror = () => setStatus('idle')
    },
    [speed]
  )

  const handlePlayPause = useCallback(async () => {
    if (isUser && !audioUrl) {
      setPlaybackError('This voice recording is no longer on this device.')
      return
    }
    const audio = audioRef.current
    if (status === 'playing' && audio) {
      audio.pause()
      setStatus('paused')
      return
    }
    setPlaybackError(null)
    setStatus('loading')
    try {
      const voice = audioUrl ? undefined : await readVoice?.().catch(() => undefined)
      if (status === 'paused' && audio && (audioUrl || srcRef.current?.voice === voice)) {
        claimVoicePlayback(messageId)
        await audio.play()
        setStatus('playing')
        return
      }
      // A changed voice must not resume or reuse the previous synthesized clip.
      audio?.pause()
      audioRef.current = null
      setCurrentTime(0)
      setLoadedDuration(0)
      const cached = srcRef.current
      let src = audioUrl || (cached && cached.voice === voice ? cached.dataUrl : null)
      if (!src) {
        const { dataUrl } = await synthesize(transcript, voice)
        if (!dataUrl) throw new Error('no audio')
        srcRef.current = { dataUrl, voice }
        src = dataUrl
      }
      const audioEl = new Audio(src)
      audioRef.current = audioEl
      wire(audioEl)
      claimVoicePlayback(messageId)
      await audioEl.play()
      setStatus('playing')
    } catch (e) {
      console.error('[voice] playback failed', e)
      setStatus('idle')
      setPlaybackError(
        audioUrl
          ? 'Voice note could not be played. Check your audio output, then try again.'
          : e instanceof Error && e.message.trim()
            ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
            : 'Speech could not be generated. Try again.'
      )
    }
  }, [status, isUser, audioUrl, readVoice, transcript, synthesize, wire, messageId])

  const cycleSpeed = useCallback(() => {
    setSpeed((prev) => {
      const next = SPEED_STEPS[(SPEED_STEPS.indexOf(prev) + 1) % SPEED_STEPS.length] ?? 1.0
      if (audioRef.current) audioRef.current.playbackRate = next
      return next
    })
  }, [])

  const seekTo = useCallback((fraction: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(audio.duration)) return
    audio.currentTime = Math.max(0, Math.min(1, fraction)) * audio.duration
    setCurrentTime(audio.currentTime)
  }, [])

  // Auto-play once a freshly-finished assistant reply is ready.
  const autoPlayedRef = useRef(false)
  useEffect(() => {
    if (autoPlay && !autoPlayedRef.current && !isLoading && status === 'idle') {
      autoPlayedRef.current = true
      void handlePlayPause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, isLoading])

  const fractionAt = (element: HTMLElement, clientX: number): number => {
    const rect = element.getBoundingClientRect()
    return rect.width ? (clientX - rect.left) / rect.width : 0
  }
  // Before playback starts nothing is on the clock, so the transcript reads as one even text.
  const transcriptTime = status === 'idle' && currentTime === 0 ? totalDuration : currentTime

  return (
    <div
      className={
        embedded
          ? 'flex w-full flex-col gap-2'
          : `flex w-[88%] max-w-[34rem] flex-col gap-2 rounded-xl border p-3 ${isUser ? 'self-end border-green-500/40 bg-green-500/10' : 'self-start border-neutral-800 bg-neutral-900/50'}`
      }
    >
      <div className="flex items-center gap-2.5">
        {/* Play / pause / loading */}
        <Button
          type="button"
          size="icon-sm"
          variant="secondary"
          onClick={handlePlayPause}
          disabled={isLoading}
          aria-pressed={status === 'playing'}
          aria-busy={status === 'loading' || undefined}
          className="shrink-0 rounded-full bg-green-500/20 text-green-500 hover:bg-green-500/30"
          title={status === 'playing' ? 'Pause' : 'Play'}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={status === 'loading' ? 'loading' : status === 'playing' ? 'pause' : 'play'}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.5, rotate: -30 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: 30 }}
              transition={{ type: 'spring', stiffness: 500, damping: 28 }}
              className="flex"
            >
              {status === 'loading' ? (
                <LoadingDots size="small" />
              ) : status === 'playing' ? (
                <Pause size={16} weight="fill" />
              ) : (
                <Play size={16} weight="fill" />
              )}
            </motion.span>
          </AnimatePresence>
        </Button>

        {/* Waveform: fills with light as it plays; drag or use the arrow keys to seek */}
        {isLoading && !isUser ? (
          <div className="flex h-10 flex-1 items-center">
            <LoadingDots className="mx-1" />
          </div>
        ) : (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Seek voice note"
            aria-valuemin={0}
            aria-valuemax={Math.round(totalDuration)}
            aria-valuenow={Math.round(progress * totalDuration)}
            aria-valuetext={`${formatDuration(progress * totalDuration)} of ${formatDuration(totalDuration)}`}
            className="relative h-10 min-w-0 flex-1 cursor-pointer touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') seekTo(progress + SEEK_STEP)
              else if (event.key === 'ArrowLeft') seekTo(progress - SEEK_STEP)
              else if (event.key === 'Home') seekTo(0)
              else if (event.key === 'End') seekTo(1)
            }}
            onPointerDown={(event) => {
              scrubbing.current = true
              event.currentTarget.setPointerCapture(event.pointerId)
              seekTo(fractionAt(event.currentTarget, event.clientX))
            }}
            onPointerMove={(event) => {
              if (scrubbing.current) seekTo(fractionAt(event.currentTarget, event.clientX))
            }}
            onPointerUp={() => (scrubbing.current = false)}
            onPointerCancel={() => (scrubbing.current = false)}
          >
            <Waveform
              data={bars}
              height={40}
              barWidth={2}
              barGap={2}
              fadeEdges={false}
              // The canvas paints with whatever --foreground computes to and falls back to black, so it
              // must be a token this app defines. --primary is not one: the bars drew black on black.
              className="opacity-70 [--foreground:var(--og-text-muted)]"
              aria-hidden="true"
            />
            <div
              className="pointer-events-none absolute inset-0"
              style={{ clipPath: `inset(0 ${100 - progress * 100}% 0 0)` }}
            >
              <Waveform
                data={bars}
                height={40}
                barWidth={2}
                barGap={2}
                fadeEdges={false}
                aria-hidden="true"
                className="[--foreground:var(--og-primary)] drop-shadow-[0_0_8px_rgb(var(--og-rgb-primary)/0.55)]"
              />
            </div>
            {progress > 0 ? (
              <div
                className="pointer-events-none absolute inset-y-1 w-px bg-primary shadow-[0_0_12px_rgb(var(--og-rgb-primary)/0.9)]"
                style={{ left: `${progress * 100}%` }}
              />
            ) : null}
          </div>
        )}
      </div>

      {/* Its own provider: voice notes also render outside the app shell's provider. */}
      <TooltipProvider delayDuration={300}>
        <div className="flex items-center justify-between">
          {transcript ? (
            <ToggleGroup
              size="sm"
              value={showTranscript ? ['transcript'] : []}
              onValueChange={(values) => setShowTranscript(values.includes('transcript'))}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <ToggleGroupItem
                    value="transcript"
                    aria-label={showTranscript ? 'Hide transcript' : 'Show transcript'}
                    className="text-neutral-500 hover:text-neutral-300"
                  >
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={showTranscript ? 'hide' : 'show'}
                        initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                        className="flex"
                      >
                        {showTranscript ? (
                          <SubtitlesSlash size={14} aria-hidden="true" />
                        ) : (
                          <Subtitles size={14} aria-hidden="true" />
                        )}
                      </motion.span>
                    </AnimatePresence>
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent>
                  {showTranscript ? 'Hide transcript' : 'Show transcript'}
                </TooltipContent>
              </Tooltip>
            </ToggleGroup>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2.5">
            <span className="min-w-[2rem] text-right text-[11px] text-neutral-500 tabular-nums">
              {isLoading
                ? '—'
                : formatDuration(status === 'idle' ? totalDuration : currentTime || totalDuration)}
            </span>
            <button
              type="button"
              onClick={cycleSpeed}
              className="cursor-pointer rounded-md border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500 active:scale-95"
              title="Playback speed"
            >
              {speed}x
            </button>
            {!isLoading && onCopy ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onCopy(transcript)}
                    className={copied ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'}
                    aria-label={copied ? 'Copied' : 'Copy transcript'}
                  >
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={copied ? 'copied' : 'copy'}
                        initial={reduceMotion ? false : { opacity: 0, scale: 0.5, rotate: -30 }}
                        animate={{ opacity: 1, scale: 1, rotate: 0 }}
                        exit={
                          reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: 30 }
                        }
                        transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                        className="flex"
                      >
                        {copied ? (
                          <Check size={13} weight="bold" aria-hidden="true" />
                        ) : (
                          <Copy size={13} aria-hidden="true" />
                        )}
                      </motion.span>
                    </AnimatePresence>
                    {copied ? (
                      <span role="status" aria-live="polite" className="sr-only">
                        Copied
                      </span>
                    ) : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copied ? 'Copied' : 'Copy transcript'}</TooltipContent>
              </Tooltip>
            ) : null}
            {!isLoading && onRetry ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    onClick={onRetry}
                    className="text-neutral-600 hover:text-green-500"
                    aria-label={isUser ? 'Resend' : 'Regenerate'}
                  >
                    <ArrowsClockwise size={13} aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isUser ? 'Resend' : 'Regenerate'}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </div>
      </TooltipProvider>

      <AutoHeight>
        <AnimatePresence initial={false}>
          {showTranscript && transcript ? (
            <motion.div
              key="transcript"
              initial={reduceMotion ? false : { opacity: 0, y: 6, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: 'blur(4px)' }}
              transition={{ duration: 0.4, ease }}
              className="border-t border-neutral-800 pt-2"
            >
              {/* Words follow the playhead; a sentence seeks there once the clip is loaded. */}
              <Transcription
                segments={segments}
                currentTime={transcriptTime}
                onSeek={(seconds) => seekTo(totalDuration ? seconds / totalDuration : 0)}
                className="gap-x-1 break-words text-xs leading-relaxed"
              >
                {(segment, index) => (
                  <TranscriptionSegment
                    key={index}
                    index={index}
                    segment={segment}
                    className="rounded-sm transition-[color,text-shadow] duration-500 ease-out data-[active=true]:[text-shadow:0_0_14px_rgb(var(--og-rgb-primary)/0.55)]"
                  />
                )}
              </Transcription>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {playbackError ? (
          <div
            role="alert"
            className="mt-2 border-t border-red-500/30 pt-2 text-[11px] leading-relaxed text-red-300"
          >
            {playbackError}
          </div>
        ) : null}
      </AutoHeight>
    </div>
  )
}
