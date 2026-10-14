import { useState } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@offgrid/operator-ui/operator/coss/input-group'
import { Button } from './ui/button'

interface ConnectorPullQueryFieldProps {
  /** The connector being asked, for the field's prompt. */
  readonly connectorName: string
  readonly disabled: boolean
  /** Pull with the query the user typed. */
  readonly onPull: (query: string) => void
}

/**
 * The "ask this connector for…" field on a connector's detail view.
 *
 * The query lived in a map on the connectors screen, so each character re-rendered every connector
 * row and the whole catalog gallery behind the panel. It lives here, and the screen is handed the
 * query once, when the user pulls.
 */
export function ConnectorPullQueryField({
  connectorName,
  disabled,
  onPull
}: ConnectorPullQueryFieldProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const pullable = query.trim().length > 0

  return (
    <>
      <InputGroup className="min-w-0 flex-1">
        <InputGroupAddon>
          <MagnifyingGlass aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pullable && !disabled) onPull(query)
          }}
          placeholder={`Ask ${connectorName} for… (e.g. ABSLI)`}
          className="text-xs"
        />
      </InputGroup>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onPull(query)}
        disabled={disabled || !pullable}
        className="shrink-0"
      >
        Pull
      </Button>
    </>
  )
}
