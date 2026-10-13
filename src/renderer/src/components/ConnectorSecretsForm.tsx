import { useState } from 'react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { Input } from '@offgrid/operator-ui/operator/coss/input'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'

interface ConnectorSecret {
  readonly key: string
  readonly label: string
  readonly placeholder?: string
}

interface ConnectorSecretsFormProps {
  readonly secrets: readonly ConnectorSecret[]
  /** Connect with the secrets as typed. Nothing is stored until this is called. */
  readonly onConnect: (secrets: Record<string, string>) => void
  readonly onCancel: () => void
  /** True while this connector's connection attempt is running. */
  readonly connecting?: boolean
}

/**
 * The secret fields a catalog connector asks for before it is connected.
 *
 * The typed secrets used to sit in a map on the connectors screen, so every character re-rendered
 * every connector row and the whole gallery, and the values outlived a cancelled connection. They
 * live here for as long as the form is open: the screen receives them once, on Connect, and they
 * go with the form when it closes.
 *
 * Fixed, masked fields rather than dice/key-value: the catalog names the keys, and key-value's
 * value field is a plain textarea that would show a token on screen as it is typed.
 */
export function ConnectorSecretsForm({
  secrets,
  onConnect,
  onCancel,
  connecting = false
}: ConnectorSecretsFormProps): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})

  return (
    <>
      {secrets.map((s) => (
        <Input
          key={s.key}
          size="sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={s.label}
          value={values[s.key] ?? ''}
          onChange={(ev) => setValues((p) => ({ ...p, [s.key]: ev.target.value }))}
          placeholder={s.label + (s.placeholder ? ` (${s.placeholder})` : '')}
          className="font-mono text-xs"
        />
      ))}
      <div className="flex gap-2">
        <Button size="xs" onClick={() => onConnect(values)} disabled={connecting}>
          <TextMorph as="span">{connecting ? 'Connecting…' : 'Connect'}</TextMorph>
        </Button>
        <Button size="xs" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  )
}
