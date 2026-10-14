import { useState } from 'react'
import { CircleNotch, DownloadSimple, UploadSimple } from '@phosphor-icons/react'
import type {
  BackupDeliveryContract,
  BackupRestoreSummaryContract
} from '../../../shared/backup-contracts'
import { Button } from './ui/button'
import { GlyphSwap, IconTip } from './IconTip'

type BackupAction = 'export' | 'restore'

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`
}

function restoreMessage(summary: BackupRestoreSummaryContract): string {
  const added =
    summary.projectsAdded +
    summary.conversationsAdded +
    summary.messagesAdded +
    summary.documentsAdded
  if (added === 0) return 'Backup checked. This device already has everything in it.'
  return `Restored ${count(summary.projectsAdded, 'project')}, ${count(summary.conversationsAdded, 'chat')}, ${count(summary.messagesAdded, 'message')}, and ${count(summary.documentsAdded, 'document')}.`
}

export function BackupRestoreSection(): React.ReactElement {
  const [busy, setBusy] = useState<BackupAction | null>(null)
  const [status, setStatus] = useState('')
  const [failed, setFailed] = useState(false)

  const run = async <T,>(
    action: BackupAction,
    operation: () => Promise<T>,
    onSuccess: (result: T) => string
  ): Promise<void> => {
    setBusy(action)
    setStatus('')
    setFailed(false)
    try {
      setStatus(onSuccess(await operation()))
    } catch (cause) {
      setFailed(true)
      setStatus(cause instanceof Error ? cause.message : 'The backup operation failed.')
    } finally {
      setBusy(null)
    }
  }

  const exportBackup = (): Promise<void> =>
    run<BackupDeliveryContract | null>(
      'export',
      () => window.api.exportBackup(),
      (result) =>
        !result || result.canceled
          ? 'Backup canceled.'
          : `Backup saved${result.path ? ` to ${result.path}` : ''}.`
    )

  const importBackup = (): Promise<void> =>
    run<BackupRestoreSummaryContract | null>(
      'restore',
      () => window.api.importBackup(),
      (result) => (result ? restoreMessage(result) : 'Restore canceled.')
    )

  const exportLabel = busy === 'export' ? 'Creating backup...' : 'Create backup'
  const restoreLabel = busy === 'restore' ? 'Restoring...' : 'Choose backup'

  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm text-neutral-200">Create a portable backup</h4>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            Save your chats, projects, project instructions, and knowledge files as one ZIP file.
          </p>
        </div>
        <IconTip label={exportLabel}>
          <Button
            type="button"
            size="icon-sm"
            aria-label={exportLabel}
            aria-busy={busy === 'export' || undefined}
            disabled={busy !== null}
            onClick={() => void exportBackup()}
            className="shrink-0 bg-emerald-600 text-white active:scale-95"
          >
            <GlyphSwap glyphKey={busy === 'export' ? 'busy' : 'idle'}>
              {busy === 'export' ? <CircleNotch className="animate-spin" /> : <DownloadSimple />}
            </GlyphSwap>
          </Button>
        </IconTip>
      </section>

      <section className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-sm text-neutral-200">Restore from a backup</h4>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            Add missing chats, projects, and knowledge files. Existing data stays unchanged.
          </p>
        </div>
        <IconTip label={restoreLabel}>
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            aria-label={restoreLabel}
            aria-busy={busy === 'restore' || undefined}
            disabled={busy !== null}
            onClick={() => void importBackup()}
            className="shrink-0 border-neutral-700 bg-transparent active:scale-95"
          >
            <GlyphSwap glyphKey={busy === 'restore' ? 'busy' : 'idle'}>
              {busy === 'restore' ? <CircleNotch className="animate-spin" /> : <UploadSimple />}
            </GlyphSwap>
          </Button>
        </IconTip>
      </section>

      {status ? (
        <p
          role={failed ? 'alert' : 'status'}
          className={`lg:col-span-2 border px-3 py-2 text-xs ${
            failed
              ? 'border-red-500/40 bg-red-500/10 text-red-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {status}
        </p>
      ) : null}
    </div>
  )
}
