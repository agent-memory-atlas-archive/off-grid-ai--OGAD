// The models Web Use and Computer Use run together, task by task: one row per role (Reasoner,
// Decision model, Grounding specialist), each saying what it does, which model fills it and where
// it runs. Shown on the Models screen's Tasks tab and in Active models. The lineups come from main
// (models:task-roles, the same view a paired browser gets); a change goes through the one role
// setter (models:set-task-role). This component only draws and asks.

import { useState, type ReactNode } from 'react'
import type { TaskRoleSlot, TaskRolesView } from '../../../shared/task-roles-view'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { Section } from '@offgrid/operator-ui/operator/experience'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { SettingsSelect } from './SettingsSelect'
import { isDecisionModel, isGroundingSpecialist, type TaskModelChoice } from '../lib/task-roles'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (): any => (window as any).api

function options(
  slot: TaskRoleSlot,
  models: readonly TaskModelChoice[],
  installed: readonly string[]
): { value: string; label: string }[] {
  // Local and remote alike, by role: a remote server's decision model carries the Decision tag.
  const fits = (m: TaskModelChoice): boolean =>
    m.availability !== 'coming_soon' &&
    installed.includes(m.id) &&
    (slot.role === 'decision' ? isDecisionModel(m) : isGroundingSpecialist(m))
  const list = models.filter(fits).map((m) => ({ value: m.id, label: m.name }))
  if (list.some((o) => o.value === slot.modelId)) return list
  // A role can still point at a model that is no longer on this device; say so.
  const missing = !slot.remote && !installed.includes(slot.modelId)
  return [
    ...list,
    { value: slot.modelId, label: missing ? `${slot.modelName} (not downloaded)` : slot.modelName }
  ]
}

export function TaskLineups(props: {
  readonly view: TaskRolesView | null
  readonly models: readonly TaskModelChoice[]
  readonly installed: readonly string[]
  /** After a role changes: the caller reloads whatever it shows besides the lineups. */
  readonly onChanged?: () => void | Promise<void>
  /** Extra detail for a slot run on this device (for example its compute backend). */
  readonly localDetail?: (slot: TaskRoleSlot) => ReactNode
}): React.ReactElement | null {
  const [busy, setBusy] = useState<string | null>(null)
  if (!props.view) return null
  const choose = async (
    task: 'computer_use' | 'web_use',
    slot: TaskRoleSlot,
    modelId: string
  ): Promise<void> => {
    if (!modelId || modelId === slot.modelId || slot.role === 'reasoner') return
    setBusy(modelId)
    try {
      await api().setTaskRole?.(task, slot.role === 'decision' ? 'decision' : 'grounding', modelId)
      await props.onChanged?.()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="space-y-5">
      {props.view.tasks.map((lineup) => (
        // The named region stays on a plain section; the library Section owns label and arrival.
        <section key={lineup.task} aria-label={<span className="whitespace-nowrap">{lineup.taskLabel}</span>}>
          <Section
            label={<span className="whitespace-nowrap">{lineup.taskLabel}</span>}
            actions={
              <span className="max-w-48 text-right text-xs text-neutral-500">
                {lineup.slots.length > 1
                  ? `${lineup.strategyLabel} · ${lineup.slots.length} models work together`
                  : lineup.strategyLabel}
              </span>
            }
          >
            {lineup.slots.length ? (
              <AnimatedGroup preset="blur-slide" className="grid gap-2">
                {lineup.slots.map((slot) => (
                  <Card
                    key={slot.role}
                    className="flex w-full min-w-0 flex-row flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1 basis-40">
                      <span className="text-[13px] text-neutral-200">{slot.label}</span>
                      <p className="text-xs leading-snug text-neutral-500">{slot.does}</p>
                    </div>
                    <div className="min-w-0 flex-1 basis-48 space-y-1">
                      {slot.role === 'reasoner' ? (
                        <span className="block truncate text-[13px] text-neutral-200">
                          {slot.modelName}
                        </span>
                      ) : (
                        <SettingsSelect<string>
                          id={`task-${lineup.task}-${slot.role}`}
                          label={`${lineup.taskLabel} ${slot.label}`}
                          value={slot.modelId}
                          disabled={busy !== null}
                          onValueChange={(modelId) => void choose(lineup.task, slot, modelId)}
                          options={options(slot, props.models, props.installed)}
                        />
                      )}
                      <div className="text-right text-xs text-neutral-500">
                        {slot.remote ? (
                          <Badge variant="success" size="sm">
                            Remote
                          </Badge>
                        ) : (
                          <>
                            On device{props.localDetail ? <> · {props.localDetail(slot)}</> : null}
                          </>
                        )}
                      </div>
                    </div>
                  </Card>
                ))}
              </AnimatedGroup>
            ) : (
              <p className="text-xs text-neutral-500">{lineup.taskLabel} uses the Chat model.</p>
            )}
          </Section>
        </section>
      ))}
    </div>
  )
}
