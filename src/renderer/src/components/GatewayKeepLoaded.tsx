import { useEffect, useMemo, useState } from 'react'
import { CheckIcon, WarningIcon } from '@phosphor-icons/react'
import { Checkbox } from '@offgrid/operator-ui/operator/animate/checkbox'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { Meter, MeterIndicator, MeterTrack } from '@offgrid/operator-ui/operator/coss/meter'
import type { KeepLoadedStateContract } from '@offgrid/core/shared/ipc-contracts'
import type { KeepLoadedModelPlan } from '@offgrid/core/shared/keep-loaded-plan'
import { cn } from '@renderer/lib/utils'
import { Button } from './ui/button'
import { IconTip } from './IconTip'

const STATUS_TONE: Record<string, string> = {
  loaded: 'text-emerald-400',
  loading: 'text-amber-300',
  unloaded: 'text-neutral-500',
  failed: 'text-red-400'
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((id) => b.includes(id))

function MemoryBar({
  label,
  used,
  budget,
  over
}: {
  label: string
  used: number
  budget: number
  over: boolean
}): React.ReactElement | null {
  if (budget <= 0 && used <= 0) return null
  const percent = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 100
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-baseline justify-between text-[10px] text-neutral-500">
        <span className="uppercase tracking-widest">{label}</span>
        <span className={cn('tabular-nums', over ? 'text-red-400' : 'text-neutral-300')}>
          {used.toFixed(1)} / {budget.toFixed(1)} GB
        </span>
      </div>
      <Meter aria-label={`${label} used by kept models`} value={percent}>
        <MeterTrack className="h-1 rounded-full bg-neutral-800">
          <MeterIndicator
            className={cn('rounded-full transition-all', over ? 'bg-red-500' : 'bg-green-500')}
          />
        </MeterTrack>
      </Meter>
    </div>
  )
}

/** One model in the list: its tick, its size in the plan, and its state in the router. */
function KeepLoadedRow({
  name,
  checked,
  place,
  live,
  onToggle
}: {
  name: string
  checked: boolean
  place: KeepLoadedModelPlan | undefined
  live: string | undefined
  onToggle: (checked: boolean) => void
}): React.ReactElement {
  return (
    <li>
      <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 transition-colors hover:border-green-500/40">
        <Checkbox
          aria-label={`Keep ${name} loaded`}
          checked={checked}
          onCheckedChange={(next) => onToggle(next === true)}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">{name}</span>
        {place && (
          <span className="shrink-0 text-[10px] tabular-nums text-neutral-500">
            {(place.gpuGb + place.ramGb).toFixed(1)} GB
            {place.nCpuMoe > 0 ? ' · experts on CPU' : ''}
          </span>
        )}
        {live && (
          <Badge variant="outline" className={cn('shrink-0 text-[10px]', STATUS_TONE[live])}>
            {live}
          </Badge>
        )}
      </label>
    </li>
  )
}

/** Which chat models the gateway keeps loaded together in its model router, with a memory bar of
 *  what the set takes. Ticking a model previews the plan; Keep loaded saves it and restarts the
 *  router. Requests naming a kept model go straight to it; every other model works as before. */
export function GatewayKeepLoaded(): React.ReactElement | null {
  const [state, setState] = useState<KeepLoadedStateContract | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const [preview, setPreview] = useState<KeepLoadedStateContract | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let mounted = true
    void window.api.keepLoadedModels().then((s: KeepLoadedStateContract) => {
      if (!mounted) return
      setState(s)
      setDraft(s.selected)
    })
    return () => {
      mounted = false
    }
  }, [])

  // While the router starts or models load, follow their state.
  const settling =
    state?.router.state === 'starting' || state?.models.some((m) => m.status === 'loading')
  useEffect(() => {
    if (!settling) return
    const timer = setInterval(() => {
      void window.api.keepLoadedModels().then((s: KeepLoadedStateContract) => setState(s))
    }, 2000)
    return () => clearInterval(timer)
  }, [settling])

  const dirty = !!state && !sameSet(draft, state.selected)
  useEffect(() => {
    if (!dirty) return
    let current = true
    void window.api.previewKeepLoadedModels(draft).then((s: KeepLoadedStateContract) => {
      if (current) setPreview(s)
    })
    return () => {
      current = false
    }
  }, [draft, dirty])

  const shown = dirty ? preview : state
  const plan = shown?.plan
  const placement = useMemo(() => new Map((plan?.models ?? []).map((m) => [m.id, m])), [plan])
  const status = useMemo(() => new Map((state?.models ?? []).map((m) => [m.id, m.status])), [state])

  if (!state) return null
  if (!state.candidates.length) {
    return <p className="text-[11px] text-neutral-500">Download a chat model to keep it loaded.</p>
  }

  const toggle = (id: string, checked: boolean): void =>
    setDraft((ids) => (checked ? [...ids, id] : ids.filter((other) => other !== id)))
  const save = (): void => {
    setSaving(true)
    void window.api
      .setKeepLoadedModels(draft)
      .then((s: KeepLoadedStateContract) => {
        setState(s)
        setDraft(s.selected)
      })
      .finally(() => setSaving(false))
  }
  const fits = plan?.fits ?? true
  const routerMessage = !dirty && state.router.state === 'error' ? state.router.message : null

  return (
    <div className="space-y-3">
      <ul aria-label="Models to keep loaded" className="grid gap-1.5 2xl:grid-cols-2">
        {state.candidates.map((model) => {
          const checked = draft.includes(model.id)
          return (
            <KeepLoadedRow
              key={model.id}
              name={model.name}
              checked={checked}
              place={checked ? placement.get(model.id) : undefined}
              live={!dirty && state.selected.includes(model.id) ? status.get(model.id) : undefined}
              onToggle={(next) => toggle(model.id, next)}
            />
          )
        })}
      </ul>

      {plan && draft.length > 0 && (
        <div className="flex flex-wrap items-end gap-4">
          <MemoryBar
            label="GPU"
            used={plan.gpuUsedGb}
            budget={plan.gpuBudgetGb}
            over={!fits && plan.reason === 'memory'}
          />
          <MemoryBar
            label="RAM"
            used={plan.ramUsedGb}
            budget={plan.ramBudgetGb}
            over={!fits && plan.reason === 'memory' && plan.ramUsedGb > plan.ramBudgetGb}
          />
          <span className="text-[10px] tabular-nums text-neutral-500">
            {plan.threadsTotal} threads
          </span>
        </div>
      )}

      {(plan?.message || routerMessage) && (
        <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-400">
          <WarningIcon aria-hidden="true" />
          {dirty ? plan?.message : (routerMessage ?? plan?.message)}
        </p>
      )}

      {dirty && (
        <IconTip label="Keep these models loaded">
          <Button size="sm" onClick={save} disabled={saving || !fits}>
            <CheckIcon aria-hidden="true" />
            Keep loaded
          </Button>
        </IconTip>
      )}
    </div>
  )
}
