import { describe, expect, it } from 'vitest'
import {
  encodeTaskExecutionPlan,
  encodeTaskPhase,
  type TaskExecutionPlan
} from '../../../shared/task-execution-plan'
import { latestBrowserTask } from '../bridge-task-progress'

const plan: TaskExecutionPlan = {
  version: 1,
  phases: [
    { id: 'phase-1', title: 'Search the shop for boots' },
    { id: 'phase-2', title: 'Report the first result' }
  ]
}

type Row = Parameters<typeof latestBrowserTask>[0][number]

const row = (over: Partial<Row> = {}): Row => ({
  taskId: 'task-1',
  journeyId: 'browser:a',
  status: 'running',
  summary: '',
  startedAt: 100,
  currentAction: 'Typing boots',
  steps: [
    encodeTaskExecutionPlan(plan),
    'working in your tab in Chrome',
    encodeTaskPhase('phase-2'),
    'read the results'
  ],
  ...over
})

describe("a browser's view of the web task it started", () => {
  it('carries the task id, plan titles, phase, trace steps and current action', () => {
    expect(latestBrowserTask([row()], 'browser:a', 50)).toEqual({
      taskId: 'task-1',
      status: 'running',
      summary: '',
      plan: ['Search the shop for boots', 'Report the first result'],
      phase: 1,
      steps: ['working in your tab in Chrome', 'read the results'],
      action: 'Typing boots'
    })
  })

  it('has no plan or action before planning and once the task ends', () => {
    expect(latestBrowserTask([row({ steps: [] })], 'browser:a', 0)).toMatchObject({
      plan: [],
      phase: -1,
      steps: []
    })
    expect(
      latestBrowserTask([row({ status: 'done', summary: 'Found boots.' })], 'browser:a', 0)
    ).toMatchObject({ status: 'done', summary: 'Found boots.', action: '' })
  })

  it("sees only this browser's tasks since the time asked, newest started first", () => {
    const runs = [
      row({ taskId: 'older', startedAt: 120 }),
      row({ taskId: 'other-browser', journeyId: 'browser:b', startedAt: 500 }),
      row({ taskId: 'newer', startedAt: 300 })
    ]
    expect(latestBrowserTask(runs, 'browser:a', 0)?.taskId).toBe('newer')
    expect(latestBrowserTask(runs, 'browser:a', 400)).toBeNull()
    expect(latestBrowserTask(runs, 'browser:c', 0)).toBeNull()
  })
})
