import { ListChecks } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import {
  closeTaskWorkspace,
  openTaskSidePanel,
  useTaskWorkspaceOpen
} from '@renderer/lib/task-side-panel'
import {
  taskAttentionCount,
  taskSessionsForJourney,
  useTaskSessions
} from '@renderer/lib/task-session-store'

interface TaskPanelTriggerProps {
  conversationId?: string | null
}

export function TaskPanelTrigger({
  conversationId = null
}: TaskPanelTriggerProps): React.JSX.Element {
  const { tasks } = useTaskSessions()
  const workspaceOpen = useTaskWorkspaceOpen()
  const reduceMotion = useReducedMotion()
  const count = taskAttentionCount(taskSessionsForJourney(tasks, conversationId))
  const label = workspaceOpen
    ? 'Close Tasks'
    : count > 0
      ? `Tasks, ${count} need attention`
      : 'Tasks'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={workspaceOpen}
          onClick={() => {
            if (workspaceOpen) closeTaskWorkspace()
            else openTaskSidePanel()
          }}
          className={`relative h-8 w-8 rounded-md border hover:border-green-500 hover:text-green-500 ${
            workspaceOpen
              ? 'border-green-500 bg-green-500/10 text-green-500'
              : 'border-neutral-800 text-neutral-500'
          }`}
        >
          <ListChecks size={16} />
          {/* The attention count pops in on a spring and leaves the way it came. */}
          <AnimatePresence initial={false}>
            {count > 0 ? (
              <motion.span
                key="attention"
                data-testid="task-attention-badge"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.4 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
                transition={
                  reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 26 }
                }
                className="absolute -right-1.5 -top-1.5 min-w-4 rounded-full bg-amber-500 px-1 text-center text-[9px] font-semibold leading-4 text-neutral-950"
              >
                {count > 9 ? '9+' : count}
              </motion.span>
            ) : null}
          </AnimatePresence>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{workspaceOpen ? 'Close Tasks' : 'Tasks'}</TooltipContent>
    </Tooltip>
  )
}
