import { useState, type FormEvent, type JSX, type KeyboardEvent } from 'react'
import { Check, DotsThree, PencilSimple, Trash, X } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Input } from '@offgrid/operator-ui/operator/coss/input'
import type { RagConversationContract } from '../../../shared/ipc-contracts'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'

interface ConversationTitleActionsProps {
  conversation: RagConversationContract
  onRenamed: (conversation: RagConversationContract) => void
  onDelete: () => void | Promise<void>
}

export function ConversationTitleActions({
  conversation,
  onRenamed,
  onDelete
}: ConversationTitleActionsProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const displayTitle = conversation.title || 'Untitled'
  const reduceMotion = useReducedMotion()

  const beginRename = (): void => {
    setDraft(conversation.title || '')
    setError(null)
    setEditing(true)
  }

  const cancelRename = (): void => {
    setDraft('')
    setError(null)
    setEditing(false)
  }

  const saveRename = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const title = draft.trim()
    if (!title) {
      setError('Enter a conversation name.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const stored = await window.api.updateRagConversationTitle(conversation.id, title)
      onRenamed(stored)
      setEditing(false)
    } catch {
      setError('Rename failed. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancelRename()
    }
  }

  if (editing) {
    return (
      <motion.div
        className="min-w-0"
        onClick={(event) => event.stopPropagation()}
        initial={reduceMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <form className="flex min-w-0 items-center gap-1" onSubmit={saveRename}>
          <Input
            autoFocus
            size="sm"
            aria-label="Rename conversation"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleInputKeyDown}
            onFocus={(event) => event.currentTarget.select()}
            disabled={saving}
            className="min-w-0 flex-1 text-xs"
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon-xs"
            aria-label="Save conversation name"
            disabled={saving}
            className="active:scale-95"
          >
            <Check />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Cancel rename"
            disabled={saving}
            onClick={cancelRename}
            className="active:scale-95"
          >
            <X />
          </Button>
        </form>
        <AnimatePresence initial={false}>
          {error && (
            <motion.p
              key="rename-error"
              role="alert"
              className="mt-1 text-[10px] text-destructive"
              initial={reduceMotion ? false : { opacity: 0, y: -4, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4, filter: 'blur(4px)' }}
              transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <p className="min-w-0 flex-1 truncate text-xs text-neutral-300">{displayTitle}</p>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Conversation actions for ${displayTitle}`}
            onClick={(event) => event.stopPropagation()}
            className="opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 active:scale-95"
          >
            <DotsThree />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-36">
          <DropdownMenuItem onSelect={beginRename}>
            <PencilSimple />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void onDelete()}>
            <Trash />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
