import { useState } from 'react'
import { Broom, CircleNotch } from '@phosphor-icons/react'
import type { CacheCleanupResultContract } from '../../../../shared/ipc-contracts'
import { formatStorageBytes } from './storage-format'
import { GlyphSwap, IconTip } from '../IconTip'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { LiveStatus } from '@offgrid/operator-ui/operator/presence'

/** Temporary Storage control. Durable-store reassurance stays beside the action. */
export function CacheCleanupControl(): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const clear = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = (await window.api.clearAppCache()) as CacheCleanupResultContract
      const reclaimed = result.freedBytes
        ? ` ${formatStorageBytes(result.freedBytes)} reclaimed.`
        : ''
      setNotice(`Temporary storage cleared.${reclaimed} Your data and models were kept.`)
    } catch {
      setNotice('Temporary storage could not be fully cleared. Installed models were kept.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 border-t border-neutral-800/60 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[11px] text-neutral-300">Temporary Storage</div>
        <div className="text-[10px] text-neutral-600">
          Clears app cache and incomplete model downloads. Installed models and your data stay.
        </div>
        {notice && (
          <LiveStatus as="div" className="mt-1 text-[10px] text-neutral-500">
            {notice}
          </LiveStatus>
        )}
      </div>
      <IconTip label={busy ? 'Clearing…' : 'Clear storage'}>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label={busy ? 'Clearing…' : 'Clear storage'}
          aria-busy={busy || undefined}
          onClick={clear}
          disabled={busy}
          className="shrink-0"
        >
          <GlyphSwap glyphKey={busy ? 'busy' : 'idle'}>
            {busy ? <CircleNotch className="animate-spin" /> : <Broom />}
          </GlyphSwap>
        </Button>
      </IconTip>
    </div>
  )
}
