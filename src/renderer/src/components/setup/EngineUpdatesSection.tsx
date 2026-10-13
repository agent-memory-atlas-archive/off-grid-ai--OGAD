import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import type { EngineUpdateStatus } from '../../../../shared/engine-updates'
import { formatStorageBytes } from './storage-format'

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
        <button
          type="button"
          role="switch"
          aria-label="Keep engines up to date"
          aria-checked={status.enabled}
          onClick={() => void window.api.engineUpdates.setEnabled(!status.enabled).then(setStatus)}
          className={`relative mt-1 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${status.enabled ? 'bg-emerald-500' : 'bg-neutral-700'}`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${status.enabled ? 'translate-x-6' : 'translate-x-1'}`}
          />
        </button>
      </div>
      <p
        role="status"
        className={`mt-2 text-[11px] ${status.phase === 'failed' ? 'text-red-400' : 'text-neutral-500'}`}
      >
        {phaseText(status)}
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
          {busy ? 'Checking...' : 'Check for engine updates'}
        </Button>
      ) : null}
    </div>
  )
}
