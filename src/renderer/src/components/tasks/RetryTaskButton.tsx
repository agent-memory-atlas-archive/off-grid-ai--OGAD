import { useEffect, useState } from 'react'
import { ArrowClockwise, CaretDown, CircleNotch, Play } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { TaskSession } from '@renderer/lib/task-session-store'
import { openTaskSidePanel } from '@renderer/lib/task-side-panel'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'

interface RetryAvailability {
  available: boolean
  reason?: string
  executionDeviceName?: string
  phases?: ReadonlyArray<{ index: number; title: string }>
  activePhaseIndex?: number
}

const STOPPING_REASON = 'The earlier run is still stopping.'
const STOPPING_RECHECK_MS = 500

/** One retry control for task details and linked Chat work cards. */
export function RetryTaskButton({
  task,
  onStarted,
  reasonInTooltip = false
}: Readonly<{
  task: TaskSession
  onStarted?: (taskId: string) => void
  /** In a header row: why it cannot continue goes in the tooltip, not a line of text below. */
  reasonInTooltip?: boolean
}>): React.JSX.Element | null {
  const [availability, setAvailability] = useState<RetryAvailability | null>(null)
  const [retrying, setRetrying] = useState(false)
  const reduceMotion = useReducedMotion()
  const retrySupported = Boolean(window.api.tasks?.retryAvailability && window.api.tasks.retry)

  useEffect(() => {
    if (task.status !== 'failed' && task.status !== 'stopped') return
    const check = window.api.tasks?.retryAvailability
    if (!check) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      void check(task.taskId).then((result) => {
        if (!current) return
        setAvailability(result)
        if (!result.available && result.reason === STOPPING_REASON) {
          timer = setTimeout(refresh, STOPPING_RECHECK_MS)
        }
      })
    }
    refresh()
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [task.taskId, task.status])

  if (task.status !== 'failed' && task.status !== 'stopped') return null
  const resolvedAvailability = retrySupported
    ? availability
    : { available: false, reason: 'Retry is not available in this build.' }
  const unavailableLabel = resolvedAvailability?.executionDeviceName
    ? `Continue on ${resolvedAvailability.executionDeviceName}`
    : 'Continue unavailable'

  const actionLabel = task.status === 'stopped' ? 'Continue' : 'Retry'
  const continueTask = (phaseIndex?: number): void => {
    const retry = window.api.tasks?.retry
    if (!retry) return
    setRetrying(true)
    void retry(task.taskId, phaseIndex)
      .then((result) => {
        if (result.taskId) {
          onStarted?.(result.taskId)
          if (!onStarted) openTaskSidePanel({ taskId: result.taskId, kind: task.kind })
        } else {
          setAvailability(result)
        }
      })
      .catch(() => {
        setAvailability({
          available: false,
          reason: 'The task could not continue. Try again on the execution device.'
        })
      })
      .finally(() => setRetrying(false))
  }
  const earlierPhases =
    resolvedAvailability?.phases?.filter(
      (phase) => phase.index <= (resolvedAvailability.activePhaseIndex ?? phase.index)
    ) ?? []

  const checking = !retrying && resolvedAvailability === null
  const label = retrying
    ? 'Continuing...'
    : resolvedAvailability === null
      ? 'Checking...'
      : resolvedAvailability.available
        ? actionLabel
        : unavailableLabel
  const glyph = retrying || checking ? 'busy' : task.status === 'stopped' ? 'continue' : 'retry'

  return (
    <div>
      {/* Its own provider: task details also render outside the app shell's provider. */}
      <TooltipProvider delayDuration={300}>
        <div className="flex items-stretch">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="outline"
                disabled={retrying || resolvedAvailability?.available !== true}
                aria-label={label}
                aria-busy={retrying || checking || undefined}
                title={resolvedAvailability?.reason}
                className="rounded-none border-neutral-700 text-neutral-300 hover:border-green-500 hover:bg-transparent hover:text-green-500 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => continueTask()}
              >
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={glyph}
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.6, rotate: -45 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: 45 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    className="flex"
                  >
                    {glyph === 'busy' ? (
                      <CircleNotch
                        aria-hidden
                        className="animate-spin motion-reduce:animate-none"
                      />
                    ) : glyph === 'continue' ? (
                      <Play aria-hidden weight="fill" />
                    ) : (
                      <ArrowClockwise aria-hidden />
                    )}
                  </motion.span>
                </AnimatePresence>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {reasonInTooltip && resolvedAvailability?.available === false
                ? (resolvedAvailability.reason ?? label)
                : label}
            </TooltipContent>
          </Tooltip>
          {earlierPhases.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                asChild
                disabled={retrying || resolvedAvailability?.available !== true}
              >
                <button
                  type="button"
                  aria-label="Continue from a saved plan step"
                  className="h-6 border border-l-0 border-neutral-700 px-1.5 text-neutral-400 transition-colors hover:border-green-500 hover:text-green-500 focus-visible:border-green-500 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CaretDown aria-hidden className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-w-80 border-neutral-800 bg-neutral-950 text-neutral-200 shadow-none"
              >
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-neutral-500">
                  Continue from plan step
                </DropdownMenuLabel>
                {earlierPhases.map((phase) => (
                  <DropdownMenuItem
                    key={phase.index}
                    className="text-xs focus:bg-green-500/15 focus:text-green-300"
                    onSelect={() => continueTask(phase.index)}
                  >
                    {phase.index + 1}. {phase.title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </TooltipProvider>
      {!reasonInTooltip &&
      resolvedAvailability?.available === false &&
      resolvedAvailability.reason ? (
        <p role="alert" className="mt-1.5 text-[10px] text-red-500">
          {resolvedAvailability.reason}
        </p>
      ) : null}
    </div>
  )
}
