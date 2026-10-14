import { useEffect, useState } from 'react'
import { ArrowsClockwise, Check, Copy, Prohibit, Swap, X } from '@phosphor-icons/react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { Field, FieldDescription, FieldError } from '@offgrid/operator-ui/operator/coss/field'
import { Input } from '@offgrid/operator-ui/operator/coss/input'
import { Label } from '@offgrid/operator-ui/operator/coss/label'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle
} from '@offgrid/operator-ui/operator/animate/alert-dialog'
import type { GatewayApiKeySettingsContract } from '../../../shared/ipc-contracts'
import { AnimatePresence, motion } from 'motion/react'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { SettingsSelect } from './SettingsSelect'
import { GlyphSwap, IconTip } from './IconTip'
import { ListRow } from '@offgrid/operator-ui/operator/list-row'
import { LiveStatus, StatePill } from '@offgrid/operator-ui/operator/presence'

export function GatewayApiKeysSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<GatewayApiKeySettingsContract | null>(null)
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState('30')
  const [date, setDate] = useState('')
  const [createdKey, setCreatedKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<{
    action: 'revoke' | 'replace' | 'disable'
    id?: string
    name?: string
  } | null>(null)

  useEffect(() => {
    let mounted = true
    window.api
      .gatewayApiKeys()
      .then((value) => {
        if (mounted) setSettings(value)
      })
      .catch(() => {
        if (mounted)
          setError('Could not read API keys. Unlock system key storage and reopen this page.')
      })
    return () => {
      mounted = false
    }
  }, [])

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update API keys.')
    } finally {
      setBusy(false)
    }
  }

  async function create(replaceId?: string, previousName?: string): Promise<void> {
    const expiresAt =
      expiry === 'never'
        ? null
        : expiry === 'custom'
          ? new Date(date).getTime()
          : Date.now() + Number(expiry) * 86400000
    const result = await window.api.createGatewayApiKey(previousName ?? name, expiresAt, replaceId)
    setSettings(result.settings)
    setCreatedKey(result.key)
    setName('')
    setConfirm(null)
  }

  if (!settings)
    return error ? (
      <FieldError match role="alert">
        {error}
      </FieldError>
    ) : <p role="status">
        <TextShimmer as="span">Loading API keys...</TextShimmer>
      </p>

  return (
    <div className="space-y-4 text-xs">
      <p className="text-neutral-400">
        Control access to the OpenAI-compatible API. Clients must send the key as an
        Authorization: Bearer header.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span role="status">
          <StatePill
            tone={settings.enabled ? 'on' : 'off'}
            label={settings.enabled ? 'API key required' : 'API key not required'}
          />
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            settings.enabled
              ? setConfirm({ action: 'disable' })
              : void run(async () => {
                  setSettings(await window.api.setGatewayApiKeyRequired(true))
                })
          }
        >
          <TextMorph as="span">
            {settings.enabled ? 'Turn off authentication' : 'Require API keys'}
          </TextMorph>
        </Button>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run(() => create())
        }}
      >
        <Field className="min-w-0 flex-1">
          <Label htmlFor="gateway-key-name">Key name</Label>
          <Input
            id="gateway-key-name"
            value={name}
            maxLength={80}
            required
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="Phone, laptop, or service"
          />
        </Field>
        <Field>
          <Label htmlFor="gateway-key-expiry">Expiry</Label>
          <SettingsSelect
            id="gateway-key-expiry"
            label="Expiry"
            value={expiry}
            disabled={busy}
            onValueChange={setExpiry}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
              { value: 'custom', label: 'Custom date and time' },
              { value: 'never', label: 'No expiry' }
            ]}
          />
        </Field>
        {expiry === 'custom' && (
          <Field>
            <Label htmlFor="gateway-key-date">Expires at (local time)</Label>
            <Input
              id="gateway-key-date"
              type="datetime-local"
              required
              value={date}
              disabled={busy}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        )}
        <Button size="sm" type="submit" disabled={busy || !name.trim() || !!createdKey}>
          Create key
        </Button>
      </form>
      <FieldDescription>
        Creating a key turns authentication on. Keys allow all model API operations. Local-only
        settings still require a local connection. MCP and paired browser connections keep their
        separate credentials.
      </FieldDescription>
      {createdKey && (
        <section className="space-y-2 rounded-md border border-neutral-800 p-3">
          <Label htmlFor="gateway-new-key">Copy this key now. It will not be shown again.</Label>
          <Input
            id="gateway-new-key"
            readOnly
            value={createdKey}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex gap-2">
            <IconTip label="Copy key">
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Copy key"
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(createdKey)
                    setNotice('Key copied.')
                  })
                }
              >
                <GlyphSwap glyphKey={notice === 'Key copied.' ? 'copied' : 'copy'}>
                  {notice === 'Key copied.' ? <Check className="text-emerald-400" /> : <Copy />}
                </GlyphSwap>
              </Button>
            </IconTip>
            <IconTip label="Done">
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Done"
                onClick={() => setCreatedKey('')}
              >
                <X />
              </Button>
            </IconTip>
          </div>
        </section>
      )}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogPopup className="sm:max-w-md" aria-label="Confirm API key change">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[17px] font-normal">
              {confirm?.action === 'disable'
                ? 'Turn off authentication?'
                : confirm?.action === 'replace'
                  ? `Replace ${confirm.name}?`
                  : `Revoke ${confirm?.name ?? 'this key'}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              {confirm?.action === 'disable'
                ? 'Allow model API requests without a key?'
                : confirm?.action === 'replace'
                  ? `Replace ${confirm.name}? The old key will stop working. The new key uses the expiry selected above.`
                  : `Revoke ${confirm?.name}? Requests with this key will be rejected.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={busy}
              render={<Button size="sm" variant="ghost" />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant={confirm?.action === 'replace' ? 'default' : 'destructive'}
              loading={busy}
              disabled={busy || (confirm?.action === 'replace' && !!createdKey)}
              onClick={() => {
                if (!confirm) return
                void run(async () => {
                  if (confirm.action === 'disable')
                    setSettings(await window.api.setGatewayApiKeyRequired(false))
                  else if (confirm.action === 'revoke')
                    setSettings(await window.api.revokeGatewayApiKey(confirm.id!))
                  else await create(confirm.id, confirm.name)
                  setConfirm(null)
                })
              }}
            >
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {error && (
        <FieldError match role="alert">
          {error}
        </FieldError>
      )}
      {notice && <LiveStatus travel="across">{notice}</LiveStatus>}
      {!settings.keys.length && (
        <p className="text-neutral-500">No API keys. Create a separate key for each client.</p>
      )}
      <ul className="divide-y divide-neutral-900" aria-label="API keys">
        <AnimatePresence initial={false}>
        {settings.keys.map((key) => {
          const status =
            key.revokedAt !== null
              ? 'Revoked'
              : key.expiresAt !== null && key.expiresAt <= Date.now()
                ? 'Expired'
                : 'Active'
          return (
            <motion.li
              key={key.id}
              layout
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            >
              <ListRow
                title={`${key.name} · ${status}`}
                description={`${key.prefix}… · Created ${new Date(key.createdAt).toLocaleString()} · ${
                  key.lastUsedAt === null
                    ? 'Never used'
                    : `Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                }`}
                meta={
                  key.expiresAt === null
                    ? 'No expiry'
                    : `Expires ${new Date(key.expiresAt).toLocaleString()}`
                }
                actions={
                  key.revokedAt === null ? (
                    <>
                      <IconTip label={`Replace ${key.name}`}>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Replace ${key.name}`}
                          disabled={busy || !!createdKey}
                          onClick={() =>
                            setConfirm({ action: 'replace', id: key.id, name: key.name })
                          }
                        >
                          <Swap />
                        </Button>
                      </IconTip>
                      <IconTip label={`Revoke ${key.name}`}>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`Revoke ${key.name}`}
                          className="hover:text-red-400"
                          disabled={busy}
                          onClick={() =>
                            setConfirm({ action: 'revoke', id: key.id, name: key.name })
                          }
                        >
                          <Prohibit />
                        </Button>
                      </IconTip>
                    </>
                  ) : undefined
                }
              />
            </motion.li>
          )
        })}
        </AnimatePresence>
      </ul>
      <IconTip label="Refresh status">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Refresh status"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setSettings(await window.api.gatewayApiKeys())
            })
          }
        >
          <ArrowsClockwise />
        </Button>
      </IconTip>
    </div>
  )
}
