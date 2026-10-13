import { useState } from 'react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import {
  KeyValue,
  KeyValueItem,
  KeyValueKeyInput,
  KeyValueList,
  KeyValueValueInput
} from '@offgrid/operator-ui/operator/dice/key-value'
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
 * Each secret is a dice/key-value row with fixed keys (the catalog names them; nothing is added or
 * removed) and a masked value with its own reveal. One KeyValue per secret, because a row's
 * labels are per secret and the list's rows share one set of props.
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
      {secrets.map((s) => {
        const label = s.label + (s.placeholder ? ` (${s.placeholder})` : '')
        return (
          <KeyValue
            key={s.key}
            fixedKeys
            masked
            trim={false}
            enablePaste={false}
            value={[{ id: s.key, key: s.label, value: values[s.key] ?? '' }]}
            onValueChange={(items) => setValues((p) => ({ ...p, [s.key]: items[0]?.value ?? '' }))}
            valuePlaceholder={label}
          >
            <KeyValueList>
              <KeyValueItem className="items-center">
                <KeyValueKeyInput
                  tabIndex={-1}
                  aria-hidden="true"
                  className="w-2/5 shrink-0 text-xs text-muted-foreground"
                />
                <KeyValueValueInput
                  aria-label={s.label}
                  autoComplete="off"
                  revealLabel={`Show ${s.label}`}
                  hideLabel={`Hide ${s.label}`}
                  className="font-mono text-xs"
                />
              </KeyValueItem>
            </KeyValueList>
          </KeyValue>
        )
      })}
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
