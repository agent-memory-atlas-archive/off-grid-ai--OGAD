import { useCallback, useEffect, useState } from 'react'
import { EyeIcon, FileDocIcon, FilePdfIcon, FilesIcon, FileTextIcon } from '@phosphor-icons/react'
import { Popover, PopoverContent, PopoverTrigger } from '@offgrid/operator-ui/operator/coss/popover'
import { Switch } from '@offgrid/operator-ui/operator/coss/switch'
import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@renderer/components/ui/tooltip'

type Row = Awaited<ReturnType<typeof window.api.documents.list>>[number] & {
  conversationId: string
}

function stateLine(row: Row): string {
  const progress = row.progress
  if (row.state === 'failed') return row.error || 'Could not be read'
  if (progress && progress.phase === 'reading') return 'Reading…'
  if (progress && progress.phase === 'ocr' && progress.total)
    return `Reading scanned pages ${progress.done}/${progress.total}`
  if (row.state !== 'ready' && progress && progress.phase === 'indexing' && progress.total)
    return `Indexing ${Math.min(99, Math.round((progress.done / progress.total) * 100))}%`
  const pages = row.pageCount
    ? `${row.pageCount.toLocaleString()} ${row.kind === 'pdf' ? 'pages' : 'parts'}`
    : ''
  const scanned = row.unreadablePages ? `${row.unreadablePages} scanned pages not read` : ''
  return [pages, scanned].filter(Boolean).join(' · ')
}

function KindIcon({ kind }: { kind: string }): React.JSX.Element {
  if (kind === 'pdf') return <FilePdfIcon className="size-4 shrink-0 text-muted-foreground" />
  if (kind === 'docx') return <FileDocIcon className="size-4 shrink-0 text-muted-foreground" />
  return <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
}

/**
 * The documents attached anywhere in this chat, and which of them answers may use (NotebookLM's
 * per-source toggle). Every answer reads every included document; nothing here is a mode to pick.
 */
export function ChatDocuments({
  conversationId,
  revision,
  onOpen
}: Readonly<{
  conversationId: string | null
  /** Changes when the conversation's messages change, so new attachments show up. */
  revision: number
  onOpen: (row: Row) => void
}>): React.JSX.Element | null {
  const [rows, setRows] = useState<Row[]>([])

  const refresh = useCallback(() => {
    if (!conversationId) return
    void window.api.documents
      .list(conversationId)
      .then((next) => setRows(next.map((row) => ({ ...row, conversationId }))))
      .catch(() => setRows([]))
  }, [conversationId])

  useEffect(refresh, [refresh, revision])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.documents.onProgress(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        refresh()
      }, 600)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  // Rows from another chat (just switched) are not shown while this chat's list loads.
  const shown = rows.filter((row) => row.conversationId === conversationId)
  if (!conversationId || !shown.length) return null
  const included = shown.filter((row) => !row.excluded).length
  const label = `${shown.length} document${shown.length === 1 ? '' : 's'} in this chat`

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={label}
            title={label}
            className="h-8 gap-1.5 rounded-full px-2.5 text-[11px]"
          />
        }
      >
        <FilesIcon className="size-3.5" />
        {included === shown.length ? shown.length : `${included}/${shown.length}`}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="border-b border-border/60 px-3 py-2 text-xs font-medium">
          Documents in this chat
        </div>
        <ul className="max-h-72 divide-y divide-border/60 overflow-y-auto">
          {shown.map((row) => (
            <li key={row.id} className="flex items-center gap-2 px-3 py-2">
              <KindIcon kind={row.kind} />
              <div className="min-w-0 flex-1">
                <div
                  className={`truncate text-xs ${row.excluded ? 'text-muted-foreground line-through' : ''}`}
                >
                  {row.name}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">{stateLine(row)}</div>
              </div>
              <TooltipProvider delayDuration={300}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Open ${row.name}`}
                      className="size-7"
                      onClick={() => onOpen(row)}
                    >
                      <EyeIcon className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Open</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <Switch
                checked={!row.excluded}
                aria-label={
                  row.excluded ? `Use ${row.name} in answers` : `Leave ${row.name} out of answers`
                }
                onCheckedChange={(checked: boolean) => {
                  setRows((current) =>
                    current.map((r) => (r.id === row.id ? { ...r, excluded: !checked } : r))
                  )
                  void window.api.documents
                    .setExcluded(conversationId, row.id, !checked)
                    .finally(refresh)
                }}
              />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
