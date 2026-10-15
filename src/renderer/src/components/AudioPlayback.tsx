// One compact audio row from the library's player: play, progress, time and speed. Every row under
// one AudioPlayerProvider shares a single <audio>, so starting one recording pauses the last.

import {
  AudioPlayerButton,
  AudioPlayerDuration,
  AudioPlayerProgress,
  AudioPlayerSpeed,
  AudioPlayerTime,
  useAudioPlayer
} from '@offgrid/operator-ui/operator/elevenlabs/audio-player'

export { AudioPlayerProvider } from '@offgrid/operator-ui/operator/elevenlabs/audio-player'

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function AudioPlayback({
  id,
  src,
  durationSec,
  className = ''
}: Readonly<{
  id: string | number
  src: string
  /** Shown before the file is loaded; the player's own duration takes over once it plays. */
  durationSec?: number | null
  className?: string
}>): React.JSX.Element {
  const player = useAudioPlayer()
  // Progress shows once the file's length is known; until then the slider has no range.
  const active =
    player.isItemActive(id) && player.duration !== undefined && Number.isFinite(player.duration)
  return (
    <div className={`flex h-8 items-center gap-2 ${className}`}>
      <AudioPlayerButton
        item={{ id, src }}
        size="icon"
        variant="ghost"
        className="size-7 shrink-0 rounded-full"
      />
      {active ? (
        <>
          <AudioPlayerProgress className="min-w-0 flex-1" />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            <AudioPlayerTime className="text-[11px]" /> /{' '}
            <AudioPlayerDuration className="text-[11px]" />
          </span>
          <AudioPlayerSpeed size="icon" className="size-7 shrink-0" />
        </>
      ) : (
        <>
          <span aria-hidden="true" className="h-1 min-w-0 flex-1 rounded-full bg-muted" />
          {durationSec ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {clock(durationSec)}
            </span>
          ) : null}
        </>
      )}
    </div>
  )
}
