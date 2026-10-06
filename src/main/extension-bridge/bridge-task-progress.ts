// What a paired browser sees of a web task it started (tasks.latest): the task's id, so it can
// stop it, and the plan, phase, steps and action the desktop's own task row shows. Pure.

import { isTaskPlanControlStep, taskExecutionPlanProgress } from '../../shared/task-execution-plan'
import type { TaskRunSnapshot } from '../tasks/task-history-store'
import type { BrowserTaskProgress } from './bridge-service'

type TaskRow = Pick<
  TaskRunSnapshot,
  'taskId' | 'status' | 'summary' | 'steps' | 'currentAction' | 'journeyId' | 'startedAt'
>

export function browserTaskProgress(run: TaskRow): BrowserTaskProgress {
  const progress = taskExecutionPlanProgress(run.steps)
  return {
    taskId: run.taskId,
    status: run.status,
    summary: run.summary ?? '',
    plan: progress?.plan.phases.map((phase) => phase.title) ?? [],
    phase: progress ? progress.activePhaseIndex : -1,
    steps: run.steps.filter((step) => !isTaskPlanControlStep(step)),
    action: run.status === 'running' ? (run.currentAction ?? '') : ''
  }
}

/** The newest task of this browser's journey started at or after `since`, as it sees it. */
export function latestBrowserTask(
  runs: readonly TaskRow[],
  journeyId: string,
  since: number
): BrowserTaskProgress | null {
  // Rows come newest-updated first; the browser asks for the task it started last.
  const run = runs
    .filter((task) => task.journeyId === journeyId && task.startedAt >= since)
    .reduce<TaskRow | null>((a, b) => (a && a.startedAt >= b.startedAt ? a : b), null)
  return run ? browserTaskProgress(run) : null
}
