import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { Code, X } from '@phosphor-icons/react'
import type { Artifact } from '../../ArtifactCanvas'
import { artifactTitle } from '../../../../../shared/artifact-title'
import { ARTIFACT_ICON } from './MessageCards'
import { PANEL_LAYER } from '../../SidePanel'

export interface ReadyArtifact {
  /** One card per finished answer. */
  id: string
  conversationId: string
  messageId: string
  artifact: Artifact
  chatTitle?: string
}

/** How long a card stays before it leaves on its own. */
const CARD_MS = 8_000

function ReadyCard({
  ready,
  onOpen,
  onDismiss
}: Readonly<{
  ready: ReadyArtifact
  onOpen: (ready: ReadyArtifact) => void
  onDismiss: (id: string) => void
}>): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(ready.id), CARD_MS)
    return () => clearTimeout(timer)
  }, [ready.id, onDismiss])
  const Icon = (ARTIFACT_ICON as Partial<Record<string, typeof Code>>)[ready.artifact.kind] ?? Code
  const label = ready.artifact.title || artifactTitle(ready.artifact.kind, ready.artifact.code)
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="pointer-events-auto flex w-72 items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950/95 shadow-lg shadow-black/40 backdrop-blur"
    >
      <button
        type="button"
        onClick={() => onOpen(ready)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-neutral-900"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-green-500">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-neutral-100">{label}</span>
          <span className="block truncate text-[11px] text-neutral-500">
            Ready{ready.chatTitle ? ` · ${ready.chatTitle}` : ''}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => onDismiss(ready.id)}
        className="mr-2 rounded p-1 text-neutral-600 transition-colors hover:text-neutral-300"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </motion.div>
  )
}

/**
 * Bottom-right cards for artifacts that just finished, in any open chat. A click opens one.
 * The side panels (the artifact pane among them) take the top layer, so the cards share it and
 * move to the end of the page when one arrives: the later element of the same layer paints on top.
 */
export function ArtifactReadyCards({
  items,
  onOpen,
  onDismiss
}: Readonly<{
  items: readonly ReadyArtifact[]
  onOpen: (ready: ReadyArtifact) => void
  onDismiss: (id: string) => void
}>): React.JSX.Element {
  const [layer] = useState(() => document.createElement('div'))
  const newest = items.at(-1)?.id
  useLayoutEffect(() => {
    if (newest) document.body.appendChild(layer)
  }, [newest, layer])
  useEffect(() => () => layer.remove(), [layer])
  return createPortal(
    <div
      style={{ zIndex: PANEL_LAYER }}
      className="pointer-events-none fixed right-4 bottom-4 flex flex-col items-end gap-2"
    >
      <AnimatePresence initial={false}>
        {items.map((ready) => (
          <ReadyCard key={ready.id} ready={ready} onOpen={onOpen} onDismiss={onDismiss} />
        ))}
      </AnimatePresence>
    </div>,
    layer
  )
}
