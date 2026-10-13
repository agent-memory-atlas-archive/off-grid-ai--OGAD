import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import type { EngineUpdateStatus } from '../../../../shared/engine-updates'
import { formatStorageBytes } from './storage-format'
import { Switch } from '@offgrid/operator-ui/operator/coss/switch'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'

const ENGINE_NAMES: Record<string, string> = {
  'llama-cuda': 'Chat and vision engine'
}

function phaseText(status: EngineUpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return 'Checking for newer engines...'
    case 'downloading':
      return status.totalBytes
        ? `Downloading ${formatStorageBytes(status.downloadedBytes)} of ${formatStorageBytes(status.totalBytes)}`
        : 'Downloading...'
    case 'installing':
      return 'Checking the new engine starts...'
    case 'failed':
      return status.error ?? 'The last engine update failed. It will try again later.'
    case 'disabled':
      return 'Engines stay on the version this app shipped with.'
    case 'up-to-date':
      return 'Engines are up to date. A new engine is used the next time a model loads.'
    default:
      return 'Newer engines install in the background.'
  }
}

/** "Keep engines up to date": on by default, so new model support arrives without an app update. */
export function EngineUpdatesSection(): React.ReactElement | null {
  const [status, setStatus] = useState<EngineUpdateStatus | null>(null)

  useEffect(() => {
    const engines = window.api.engineUpdates as Partial<typeof window.api.engineUpdates> | undefined
    if (typeof engines?.status !== 'function') return
    void engines
      .status()
      .then(setStatus)
      .catch(() => {})
    return engines.onChanged?.(setStatus)
  }, [])

  if (!status || status.phase === 'unsupported') return null
  const busy = ['checking', 'downloading', 'installing'].includes(status.phase)
  const installed = Object.entries(status.installed)

  return (
    <div className="mt-4 border-t border-neutral-800 pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs text-neutral-200">Keep engines up to date</p>
          <p className="mt-1 text-[11px] leading-5 text-neutral-500">
            Installs newer GPU engines in the background so new models work without waiting for an
            app update.
          </p>
        </div>
        <Switch
          className="mt-1"
          aria-label="Keep engines up to date"
          checked={status.enabled}
          onCheckedChange={() =>
            void window.api.engineUpdates.setEnabled(!status.enabled).then(setStatus)
          }
        />
      </div>
      <p
        role="status"
        className={`mt-2 text-[11px] ${status.phase === 'failed' ? 'text-red-400' : 'text-neutral-500'}`}
      >
        {busy ? <TextShimmer as="span">{phaseText(status)}</TextShimmer> : phaseText(status)}
      </p>
      {installed.length ? (
        <p className="mt-1 text-[11px] text-neutral-500">
          {installed.map(([id, version]) => `${ENGINE_NAMES[id] ?? id}: ${version}`).join(' · ')}
        </p>
      ) : null}
      {status.enabled ? (
        <Button
          size="xs"
          variant="outline"
          className="mt-3"
          disabled={busy}
          onClick={() => void window.api.engineUpdates.check().then(setStatus)}
        >
          <TextMorph as="span">{busy ? 'Checking...' : 'Check for engine updates'}</TextMorph>
        </Button>
      ) : null}
    </div>
  )
}
