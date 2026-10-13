import { useState, type MouseEvent, type ReactNode } from 'react'
import type { ChatStreamTool, ProjectedSyncedTool } from '@offgrid/sync'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { AutoHeight } from '@offgrid/operator-ui/operator/presence'
import {
  ToolTimeline,
  type ToolTimelineProps,
  type ToolTraceEntry
} from '@offgrid/operator-ui/operator/workflows/tool-timeline'
import { ChatMarkdown } from './ChatMarkdown'
import type { AssistantTimelineEntry } from '@renderer/lib/message-persistence'
import { type TaskSession, useTaskSessionsForReferences } from '@renderer/lib/task-session-store'
import {
  closeTaskWorkspace,
  openTaskSidePanel,
  useTaskWorkspaceOpen
} from '@renderer/lib/task-side-panel'
import { ComputerUseStepDetails } from './tasks/ComputerUseStepDetails'
import { RetryTaskButton } from './tasks/RetryTaskButton'
import { taskReferenceFromResult, visibleToolResult } from './chat-tool-projection'

type DisplayTool =
  | Pick<ProjectedSyncedTool, 'name' | 'arguments' | 'result' | 'status' | 'durationMs' | 'error'>
  | ChatStreamTool

interface ChatToolRowsProps {
  tools?: readonly DisplayTool[]
  thinking?: ReactNode
  /** Whether the thinking row has content beyond a waiting indicator. */
  thinkingHasContent?: boolean
  /** Live status shown below, but outside, the ordered work timeline. */
  footer?: ReactNode
  timeline?: readonly AssistantTimelineEntry[]
  thinkingLive?: boolean
  memorySources?: { count: number; content: ReactNode }
  /** The task that belongs to this live Chat turn before its tool result contains a task id. */
  liveTask?: TaskSession
  /** Open the timeline while this response is live, then close it when the response completes. */
  live?: boolean
  /** A final or stopped response closes work even if an earlier tool retained running state. */
  settled?: boolean
  /** The user stopped this turn before normal completion. */
  stopped?: boolean
  /** The model failed after it had started this turn. */
  failed?: boolean
}

type WorkStatus = 'running' | 'complete' | 'failed' | 'needs attention'

type ToolEntryState = Extract<ToolTraceEntry, { kind: 'tool' }>['state']

/** The timeline's step badge speaks the library's states; the product keeps its own words. */
const ENTRY_STATE: Record<WorkStatus, ToolEntryState> = {
  running: 'running',
  complete: 'success',
  failed: 'error',
  'needs attention': 'needs-attention'
}

/** The collapsed step line sits beside the step name, so long updates move into the detail. */
const SUMMARY_LIMIT = 64

const PROPOSAL_STAGE_LABELS: Record<string, string> = {
  start: 'Started proposal',
  status: 'Checked proposal progress',
  save_website_context: 'Saved website research',
  save_narrative_plan: 'Drafted proposal story',
  revise_narrative_plan: 'Revised proposal story',
  approve_narrative_plan: 'Approved proposal story',
  save_skeleton: 'Built slide plan',
  revise_skeleton: 'Revised slide plan',
  approve_skeleton: 'Approved slide plan',
  save_case_studies: 'Collected supporting proof',
  select_case_studies: 'Selected case studies',
  save_full_copy: 'Wrote slide copy',
  revise_full_copy: 'Revised slide copy',
  regenerate_illustration: 'Regenerated illustration',
  approve_full_copy: 'Approved final deck'
}

const TOOL_LABELS: Record<string, string> = {
  web_use: 'Web Use',
  computer_use: 'Computer Use',
  generate_image: 'Generated image',
  image_generation: 'Generated image',
  search_memory: 'Searched memory',
  search_replay: 'Searched activity',
  search_meetings: 'Searched meetings',
  web_search: 'Searched the web',
  brave_search: 'Searched the web',
  read_url: 'Read web page',
  search_messages: 'Searched messages',
  list_folder: 'Listed folder',
  list_directory: 'Listed folder',
  read_folder: 'Read folder',
  read_file: 'Read file',
  write_file: 'Created output',
  create_file: 'Created output',
  save_file: 'Saved output',
  action_approval: 'Requested approval',
  request_approval: 'Requested approval'
}

function parseArguments(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function normalizedToolKey(name: string): string {
  return name
    .replace(/^mcp__\d+__/, '')
    .replace(/^mcp_\d+_+/, '')
    .replace(/^pro:/, '')
    .toLowerCase()
}

function taskKindForTool(name: string): TaskSession['kind'] | undefined {
  const key = normalizedToolKey(name)
  if (key === 'web_use') return 'web_use'
  if (key === 'computer_use') return 'computer_use'
  return undefined
}

function titleFromIdentifier(name: string): string {
  const clean = normalizedToolKey(name)
    .replace(/[:._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'Used tool'
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

function workStepLabel(tool: DisplayTool): string {
  const key = normalizedToolKey(tool.name)
  if (key === 'proposal_deck') {
    const action = String(
      parseArguments('arguments' in tool ? tool.arguments : undefined)?.action ?? ''
    )
    return PROPOSAL_STAGE_LABELS[action] ?? 'Updated proposal deck'
  }
  return TOOL_LABELS[key] ?? titleFromIdentifier(key)
}

function workStatus(tool: DisplayTool): WorkStatus {
  const result = visibleToolResult(tool.result)
  if ('error' in tool && tool.error?.trim()) return 'failed'
  if (/^\s*(error|failed)\s*:/i.test(result)) return 'failed'
  if (tool.status === 'failed') return 'failed'
  if (tool.status === 'pending' || tool.status === 'cancelled') return 'needs attention'
  if (tool.status === 'running') return 'running'
  return 'complete'
}

function shortResult(tool: DisplayTool, status = workStatus(tool), taskSummary?: string): string {
  if (taskSummary?.trim()) return taskSummary.trim()
  if (status === 'running') return 'In progress.'
  if (status === 'needs attention') return 'Waiting for your attention.'
  const key = normalizedToolKey(tool.name)
  if (key === 'read_file') {
    return status === 'failed' ? 'The file could not be read.' : 'Read the selected file.'
  }
  if (key === 'read_folder') {
    return status === 'failed' ? 'The folder could not be read.' : 'Read the selected folder.'
  }
  if (key === 'list_folder' || key === 'list_directory') {
    return status === 'failed' ? 'The folder could not be listed.' : 'Listed the selected folder.'
  }
  if (key === 'write_file' || key === 'create_file' || key === 'save_file') {
    return status === 'failed' ? 'The output could not be saved.' : 'Saved the requested output.'
  }
  if (key === 'generate_image' || key === 'image_generation') {
    return status === 'failed' ? 'The image could not be created.' : 'Created the requested image.'
  }
  if (key === 'web_search' || key === 'brave_search') return 'Search results are ready.'
  if (key === 'read_url') return 'Read the selected web page.'
  if (key === 'search_meetings') {
    const result = visibleToolResult(tool.result).trim()
    if (result) return result.split(/\r?\n/, 1)[0]!
  }
  if (key.startsWith('search_')) return 'Found matching items.'
  if (status === 'failed') return 'This step failed. Open it for details.'
  const value = ('error' in tool && tool.error?.trim()) || visibleToolResult(tool.result)
  if (!value) return 'Step finished.'
  const firstLine = value
    .split(/\r?\n/, 1)[0]!
    .replace(/\/(?:Users|home)\/[^\s]+/g, '[local file]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[local file]')
    .trim()
  if (!firstLine || firstLine.startsWith('{') || firstLine.startsWith('[')) {
    return 'Result is ready.'
  }
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine
}

function taskWorkStatus(task: TaskSession | undefined): WorkStatus | undefined {
  if (!task) return undefined
  if (task.status === 'failed' || task.status === 'stopped') return 'failed'
  if (task.status === 'paused' || task.status === 'waiting') return 'needs attention'
  if (task.status === 'running' || task.status === 'reconnecting') return 'running'
  return 'complete'
}

function linkedTaskForReference(
  tasks: readonly TaskSession[],
  reference: string | undefined
): TaskSession | undefined {
  if (!reference) return undefined
  const referenced = tasks.find((task) => task.taskId === reference)
  const journeyId = referenced?.journeyId ?? reference
  return tasks
    .filter((task) => task.taskId === reference || task.journeyId === journeyId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.taskId.localeCompare(a.taskId))[0]
}

function liveTaskToolIndex(
  tools: readonly DisplayTool[],
  liveTask: TaskSession | undefined
): number {
  if (!liveTask) return -1
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index]!
    if (
      !taskReferenceFromResult(tool.result) &&
      workStatus(tool) === 'running' &&
      taskKindForTool(tool.name) === liveTask.kind
    ) {
      return index
    }
  }
  return -1
}

/** One persisted execution timeline for both live previews and durable assistant turns. */
export function ChatToolRows({
  tools,
  thinking,
  thinkingHasContent = Boolean(thinking),
  footer,
  timeline,
  thinkingLive = false,
  memorySources,
  liveTask,
  live = false,
  settled = false,
  stopped = false,
  failed = false
}: Readonly<ChatToolRowsProps>): React.JSX.Element | null {
  const taskWorkspaceOpen = useTaskWorkspaceOpen()
  // Web Use can start before toolChat returns its durable tool result. Project one
  // pending row from the live task so the chat reports work at the time it happens.
  // Once the real tool call arrives, it replaces this transient projection.
  const visible: readonly DisplayTool[] = tools?.length
    ? tools
    : memorySources
      ? [{ name: 'search_memory', result: '', status: 'completed' }]
      : !liveTask
        ? []
        : [
            {
              name: liveTask.kind === 'web_use' ? 'web_use' : 'computer_use',
              arguments: '{}',
              result: '',
              status: 'running'
            }
          ]
  const taskReferences = visible.flatMap((tool) => {
    const reference = taskReferenceFromResult(tool.result)
    return reference ? [reference] : []
  })
  const tasks = useTaskSessionsForReferences(taskReferences)
  const liveToolIndex = liveTaskToolIndex(visible, liveTask)
  const projected = visible.map((tool, index) => {
    const taskId = taskReferenceFromResult(tool.result)
    const linkedTask =
      linkedTaskForReference(tasks, taskId) ?? (index === liveToolIndex ? liveTask : undefined)
    return { tool, taskId, linkedTask, status: taskWorkStatus(linkedTask) ?? workStatus(tool) }
  })
  const workIsLive =
    live ||
    (!stopped && !failed && !settled && projected.some(({ status }) => status === 'running'))
  const workState: ToolTimelineProps['state'] = workIsLive
    ? 'working'
    : stopped
      ? 'stopped'
      : failed
        ? 'failed'
        : 'done'
  // The caller owns the disclosure: open while the response is live, closed once it settles,
  // and the person's own toggle holds until the work changes state again.
  const [expanded, setExpanded] = useState(workIsLive)
  const [expandedFor, setExpandedFor] = useState(workState)
  if (expandedFor !== workState) {
    setExpandedFor(workState)
    setExpanded(workIsLive)
  }
  if (visible.length === 0 && !thinking && !timeline?.length && !stopped && !failed) return null

  const firstMemoryToolIndex = visible.findIndex(
    (tool) => normalizedToolKey(tool.name) === 'search_memory' && workStatus(tool) === 'complete'
  )
  const ordered: AssistantTimelineEntry[] = timeline?.length
    ? [
        ...timeline,
        ...projected.flatMap((_, index) =>
          timeline.some((entry) => entry.kind === 'tool' && entry.toolIndex === index)
            ? []
            : [{ kind: 'tool' as const, toolIndex: index }]
        )
      ]
    : projected.map((_, index) => ({ kind: 'tool', toolIndex: index }))
  const hasOrderedThinking = ordered.some((entry) => entry.kind === 'thinking')
  // The ephemeral mesh preview retains only its newest tools. Durable toolCalls has every call.
  const toolOffset = Math.max(
    0,
    ordered.filter((entry) => entry.kind === 'tool').length - projected.length
  )

  /** Linked task per rendered step, so a step's own row can open its task. */
  const stepTasks: Array<TaskSession | undefined> = []
  const entries: ToolTraceEntry[] = []
  const pushThinking = (id: string, text: ReactNode, streaming: boolean): void => {
    stepTasks.push(undefined)
    entries.push({ id, kind: 'thinking', text, streaming })
  }
  const liveThinking = (): void => {
    if (thinking) pushThinking('thinking:live', thinking, workIsLive && !thinkingHasContent)
  }

  if (!hasOrderedThinking) liveThinking()
  ordered.forEach((entry, orderIndex) => {
    if (entry.kind === 'thinking') {
      const streaming = thinkingLive && orderIndex === ordered.length - 1
      if (!entry.text.trim() && !streaming) return
      pushThinking(
        `thinking:${orderIndex}`,
        entry.text.trim() ? <ChatMarkdown content={entry.text} /> : null,
        streaming
      )
      return
    }
    const projectedTool = projected[entry.toolIndex - toolOffset]
    if (!projectedTool) return
    const { tool, linkedTask, status: stepStatus } = projectedTool
    const memoryTool = normalizedToolKey(tool.name) === 'search_memory'
    const showMemorySources = Boolean(
      memorySources && entry.toolIndex === firstMemoryToolIndex + toolOffset
    )
    const sourceCount = memorySources?.count ?? 0
    const stepLabel = showMemorySources
      ? `Searched your memory — ${sourceCount} result${sourceCount === 1 ? '' : 's'}`
      : workStepLabel(tool)
    const result = visibleToolResult(tool.result)
    const error = 'error' in tool ? tool.error?.trim() : undefined
    const taskSummary = linkedTask?.summary?.trim()
    const liveTaskLine = stepStatus === 'running' ? linkedTask?.currentAction?.trim() : undefined
    const rowSummary = liveTaskLine || taskSummary
    const details = taskSummary || error || result
    const durationMs = 'durationMs' in tool ? tool.durationMs : undefined
    const hasComputerDetails = Boolean(linkedTask?.stepDetails?.length)
    const hasDisclosure =
      showMemorySources ||
      (!(memorySources && memoryTool && stepStatus === 'complete') &&
        (Boolean(details) || hasComputerDetails || Boolean(linkedTask)))
    const line = showMemorySources ? undefined : shortResult(tool, stepStatus, rowSummary)
    const lineIsLong = Boolean(line && line.length > SUMMARY_LIMIT)
    const summary = line && lineIsLong ? `${line.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…` : line
    const detail = !hasDisclosure ? undefined : showMemorySources ? (
      <div className="max-h-[400px] overflow-y-auto text-sm">{memorySources?.content}</div>
    ) : (
      <AutoHeight className="space-y-2 leading-relaxed text-muted-foreground">
        {lineIsLong && line !== details ? <p>{line}</p> : null}
        {details ? <ChatMarkdown content={details} /> : null}
        <ComputerUseStepDetails details={linkedTask?.stepDetails} />
        {linkedTask ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() =>
                taskWorkspaceOpen
                  ? closeTaskWorkspace()
                  : openTaskSidePanel({
                      taskId: linkedTask.taskId,
                      kind: linkedTask.kind,
                      detail: true
                    })
              }
            >
              <TextMorph as="span">
                {taskWorkspaceOpen ? 'Close task details' : 'Open task details'}
              </TextMorph>
            </Button>
            <RetryTaskButton task={linkedTask} />
          </div>
        ) : null}
      </AutoHeight>
    )
    stepTasks.push(linkedTask)
    entries.push({
      id: `${tool.name}:${entry.toolIndex}`,
      kind: 'tool',
      name: stepLabel,
      state: ENTRY_STATE[stepStatus],
      summary,
      result: detail,
      ...(durationMs === undefined ? {} : { time: `${Math.round(durationMs)} ms` })
    })
  })
  if (hasOrderedThinking) liveThinking()

  // A linked task's step row opens that task as well as its detail. The timeline renders
  // each step's header as the first button of its list item, so route that click here.
  const openStepTask = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    const item = target.closest<HTMLElement>('[role="listitem"]')
    const button = target.closest('button')
    if (!item || !button || button !== item.querySelector('button')) return
    const items = Array.from(item.parentElement?.children ?? []).filter(
      (child) => child.getAttribute('role') === 'listitem'
    )
    const task = stepTasks[items.indexOf(item)]
    if (task) openTaskSidePanel({ taskId: task.taskId, kind: task.kind, detail: true })
  }

  return (
    <>
      <div
        className="ml-1 w-full max-w-[85%]"
        aria-busy={workIsLive || undefined}
        onClick={openStepTask}
      >
        <ToolTimeline
          entries={entries}
          state={workState}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
      </div>
      {footer ? (
        <div
          className="ml-5 mt-2 inline-flex items-center text-neutral-500"
          role="status"
          aria-live="polite"
          aria-label="Working"
        >
          {footer}
        </div>
      ) : null}
    </>
  )
}
