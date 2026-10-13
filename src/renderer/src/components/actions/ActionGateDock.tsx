/**
 * The inline action surface (Approval UX v2, R2-B3): pending gate cards and
 * recent outcomes, in the conversation flow above the composer.
 *
 * A gated action renders as a card - the resolved values, the risk, and
 * Approve / Edit / Reject - resolved through the engine gate, so what you
 * approve is byte-for-byte what runs. Outcomes land back here: a verified
 * confirmation with Undo when the handler can reverse the effect, or the
 * honest failure. Auto-run reversibles skip the card and appear directly as
 * an undoable confirmation.
 *
 * Self-contained on purpose: it subscribes to the preload feed and never
 * touches the chat's message model, so non-action turns are untouched.
 */
import { useEffect, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { motion, useReducedMotion } from 'motion/react'
import { Card } from '@offgrid/operator-ui/operator/coss/card'
import { Input } from '@offgrid/operator-ui/operator/coss/input'
import { Button } from '@renderer/components/ui/button'
import { presentActionApproval } from './action-approval-presentation'

interface GateRequest {
  actionId: string
  actionType: string
  title: string
  args: Record<string, unknown>
  risk: string
  sourceRef?: string
}

interface OutcomeEvent {
  id: string
  outcome: 'done' | 'rejected' | 'needs_help' | 'edited' | 'poisoned'
  record?: { type?: string; intent?: string; attemptLog?: Array<{ detail?: string }> }
  error?: string
  undoable?: boolean
}

const OUTCOME_LABEL: Record<string, string> = {
  done: 'Done - verified',
  rejected: 'Declined',
  needs_help: 'Ran but could not be confirmed - needs your attention',
  poisoned: 'Failed'
}

export function ActionGateDock({
  conversationId
}: Readonly<{ conversationId: string | null }>): React.JSX.Element | null {
  const [pending, setPending] = useState<GateRequest[]>([])
  const [outcomes, setOutcomes] = useState<OutcomeEvent[]>([])
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({})
  const [undone, setUndone] = useState<Record<string, string>>({})
  const reduceMotion = useReducedMotion()
  // Cards and outcome rows rise in. They leave at once: a decided card is gone the instant
  // the user decides, so no exit lingers over the composer.
  const arrive = reduceMotion
    ? { initial: false as const }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] as const }
      }

  useEffect(() => {
    const offPending = window.api.actions?.onGatePending((request) => {
      const req = request as GateRequest
      setPending((current) => [...current.filter((p) => p.actionId !== req.actionId), req])
    })
    const offOutcome = window.api.actions?.onOutcome((event) => {
      const outcome = event as OutcomeEvent
      setPending((current) => current.filter((p) => p.actionId !== outcome.id))
      if (outcome.outcome === 'edited') {
        return // the re-gated card arrives as its own pending event
      }
      setOutcomes((current) => [...current.slice(-2), outcome])
    })
    return () => {
      offPending?.()
      offOutcome?.()
    }
  }, [])

  const resolve = (actionId: string, decision: unknown): void => {
    // Drop the card the instant the user decides, so it doesn't sit there while the
    // action runs and the outcome makes its way back. An edit re-gates and arrives as
    // its own fresh pending event; approve/reject land as an outcome row.
    setPending((current) => current.filter((p) => p.actionId !== actionId))
    void window.api.actions?.resolveGate(actionId, decision)
  }

  const undo = async (event: OutcomeEvent): Promise<void> => {
    const result = await window.api.actions?.undo(event.record)
    setUndone((current) => ({
      ...current,
      [event.id]: result?.ok ? 'Undone' : (result?.detail ?? 'Undo failed')
    }))
  }

  // sourceRef is the task's existing Chat owner. The same rule applies in free
  // and Pro builds, and a different open Chat cannot display or decide this gate.
  const visiblePending = pending.filter(
    (request) => conversationId !== null && request.sourceRef === conversationId
  )
  // Pro writes every Action result into its execution chat and the shared task
  // timeline. A second global banner above an unrelated chat composer has no
  // stable conversation owner and can show stale, context-free outcomes.
  const visibleOutcomes = window.api.isPro ? [] : outcomes
  if (visiblePending.length === 0 && visibleOutcomes.length === 0) {
    return null
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-3 font-mono">
      {visiblePending.map((request) => {
        const editing = edits[request.actionId]
        const presentation = presentActionApproval(request)
        return (
          <motion.div key={request.actionId} {...arrive}>
            <Card data-testid="gate-card" className="gap-0 p-4 text-sm">
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Approval needed
              </div>
              <div className="mt-2 font-medium text-foreground">{presentation.title}</div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {presentation.description}
              </div>
              <div className="mt-4 divide-y divide-neutral-900">
                {presentation.details.map((detail) => (
                  <div
                    key={detail.key}
                    className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2 py-2 text-xs"
                  >
                    <span className="text-muted-foreground">{detail.label}</span>
                    {editing ? (
                      <Input
                        size="sm"
                        aria-label={`edit ${detail.label.toLowerCase()}`}
                        className="text-xs"
                        value={editing[detail.key] ?? detail.editValue}
                        onChange={(e) =>
                          setEdits((current) => ({
                            ...current,
                            [request.actionId]: {
                              ...current[request.actionId],
                              [detail.key]: e.target.value
                            }
                          }))
                        }
                      />
                    ) : (
                      <span className="break-words text-foreground">{detail.value}</span>
                    )}
                  </div>
                ))}
              </div>
              {presentation.warning ? (
                <div className="mt-4 text-xs text-amber-600 dark:text-amber-400">
                  {presentation.warning}
                </div>
              ) : null}
              <div className="mt-4 flex items-center gap-2">
                {editing ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      const args = { ...request.args, ...editing }
                      setEdits((current) => {
                        const { [request.actionId]: _dropped, ...rest } = current
                        return rest
                      })
                      resolve(request.actionId, { kind: 'edit', args })
                    }}
                  >
                    Save changes
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      disabled={!presentation.canApprove}
                      onClick={() => resolve(request.actionId, { kind: 'approve' })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        setEdits((current) => ({ ...current, [request.actionId]: {} }))
                      }
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        resolve(request.actionId, { kind: 'reject', reason: 'declined in chat' })
                      }
                    >
                      Reject
                    </Button>
                  </>
                )}
              </div>
            </Card>
          </motion.div>
        )
      })}
      {visibleOutcomes.map((event) => (
        <motion.div
          key={event.id}
          {...arrive}
          data-testid="outcome-row"
          className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-4 py-2.5 text-xs"
        >
          <span className={event.outcome === 'done' ? 'text-primary' : 'text-muted-foreground'}>
            {event.record?.intent ? `${event.record.intent} - ` : ''}
            {undone[event.id] ?? OUTCOME_LABEL[event.outcome] ?? event.outcome}
            {event.outcome === 'poisoned' && event.error ? ` (${event.error})` : ''}
          </span>
          <span className="flex items-center gap-1">
            {event.undoable && !undone[event.id] ? (
              <Button size="sm" variant="outline" onClick={() => void undo(event)}>
                Undo
              </Button>
            ) : null}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() => setOutcomes((current) => current.filter((o) => o.id !== event.id))}
            >
              <X />
            </Button>
          </span>
        </motion.div>
      ))}
    </div>
  )
}
