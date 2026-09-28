import { useEffect, useMemo, useState } from 'react'
import {
  ArrowSquareOut,
  MagnifyingGlass,
  SlidersHorizontal,
  Eye,
  ArrowUpRight,
  ArrowDownLeft,
  ArrowClockwise,
  Trash,
  HardDrives,
  Pulse,
  Pause,
  ListMagnifyingGlass
} from '@phosphor-icons/react'
import {
  AI_LOG_POLICY,
  AI_MODALITIES,
  type AILogAttachment,
  type AILogQuery,
  type AILogPage,
  type AIRequestRecord,
  type AIRequestSummary
} from '@offgrid/core/shared/ai-request-log'
import { Button } from './ui/button'
import { SettingsSelect } from './SettingsSelect'
import { CopyButton } from './ui/CopyButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel
} from './ui/dropdown-menu'

const labels = {
  text: 'Text & vision',
  image: 'Images',
  tts: 'Voice',
  stt: 'Transcription',
  embedding: 'Embeddings'
}
const initialDisplay = { request: true, response: true, model: true, details: true }
type Display = typeof initialDisplay
const inputClass =
  'min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring'
const duration = (ms?: number): string =>
  ms === undefined ? 'In progress' : `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Could not load activity. Try Refresh.'

function readDisplay(): Display {
  try {
    const stored = JSON.parse(window.localStorage.getItem('ai-activity-display') || '{}')
    return Object.fromEntries(
      Object.entries(initialDisplay).map(([key, value]) => [
        key,
        typeof stored?.[key] === 'boolean' ? stored[key] : value
      ])
    ) as Display
  } catch {
    return initialDisplay
  }
}

/** Human-readable projection; Raw preserves the bounded stored payload. */
function readableAIValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return 'Not recorded'
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'number'))
      return `${value.length} values\n${JSON.stringify(value)}`
    return value.map(readableAIValue).join('\n\n')
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (object.attachment) return 'Media attachment (open below)'
    if (object.result !== undefined)
      return (
        readableAIValue(object.result) +
        (object.reasoning ? `\n\nReasoning\n${readableAIValue(object.reasoning)}` : '')
      )
    if (object.choices) return readableAIValue(object.choices)
    if (object.message) return readableAIValue(object.message)
    if (object.messages) return readableAIValue(object.messages)
    if (object.content !== undefined)
      return `${object.role ? `${object.role}\n` : ''}${readableAIValue(object.content)}${object.toolCalls ? `\n\nTool calls\n${JSON.stringify(object.toolCalls, null, 2)}` : ''}`
    if (object.text !== undefined) return readableAIValue(object.text)
    if (object.prompt !== undefined) return readableAIValue(object.prompt)
  }
  return JSON.stringify(value, null, 2)
}

function Payload({ title, value }: { title: string; value: unknown }): React.ReactElement {
  const text = readableAIValue(value)
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? text : text.slice(0, 6000)
  return (
    <section className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-normal">
          {title === 'Request' ? <ArrowUpRight /> : <ArrowDownLeft />}
          {title}
        </h3>
        <CopyButton text={text} label={`Copy ${title.toLowerCase()}`} />
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-4 font-mono text-sm leading-relaxed text-foreground">
        {shown}
      </pre>
      {text.length > 6000 && (
        <Button variant="ghost" size="xs" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : `Show all (${text.length.toLocaleString()} characters)`}
        </Button>
      )}
    </section>
  )
}

function Attachment({
  recordId,
  asset
}: {
  recordId: string
  asset: AILogAttachment
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  async function load(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const result = await window.api.aiLogsAttachment(recordId, asset.id)
      if (!result) throw new Error('This media is no longer available.')
      setUrl(result)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all text-xs text-muted-foreground">
          {asset.mime} · {(asset.bytes / 1024).toFixed(0)} KB
        </span>
        <Button
          variant="outline"
          size="xs"
          disabled={loading}
          onClick={() => (url ? setUrl(null) : void load())}
        >
          {loading ? 'Loading media...' : url ? 'Hide media' : 'Open media'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-muted-foreground">
          {error}
        </p>
      )}
      {url &&
        (asset.mime.startsWith('image/') ? (
          <img
            src={url}
            alt="AI request or response attachment"
            className="max-h-96 max-w-full rounded-md object-contain"
          />
        ) : (
          <audio src={url} controls preload="metadata" className="w-full" />
        ))}
    </div>
  )
}

function RequestDetail({
  record,
  display,
  raw
}: {
  record: AIRequestRecord
  display: Display
  raw: boolean
}): React.ReactElement {
  const [related, setRelated] = useState<AIRequestSummary[]>([])
  useEffect(() => {
    let disposed = false
    void window.api
      .aiLogsRelated(record.id)
      .then((rows) => {
        if (!disposed) setRelated(rows)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [record.id, record.status])
  const visible = {
    id: record.id,
    parentId: record.parentId,
    modality: record.modality,
    source: record.source,
    status: record.status,
    ...(display.model ? { model: record.model, backend: record.backend } : {}),
    ...(display.request
      ? { request: record.request, effectiveRequest: record.effectiveRequest }
      : {}),
    ...(display.response ? { response: record.response, error: record.error } : {}),
    ...(display.details
      ? {
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
          durationMs: record.durationMs,
          metrics: record.metrics
        }
      : {})
  }
  const attachments = (record.attachments ?? []).filter(
    (asset) =>
      (display.request && /\.(request|effectiveRequest)(\.|$)/.test(asset.label)) ||
      (display.response && /\.response(\.|$)/.test(asset.label))
  )
  return (
    <div className="min-w-0 space-y-5">
      <div>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{record.source}</p>
        <h2 className="mt-2 break-words text-base font-normal">{record.preview}</h2>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{new Date(record.startedAt).toLocaleString()}</span>
          <span>{record.status}</span>
          {display.details && <span>{duration(record.durationMs)}</span>}
        </div>
        {display.model && (
          <dl className="mt-4 grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 border-y border-border py-3">
            <div className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Model</dt>
              <dd className="mt-1 break-words text-sm">{record.model ?? 'Not reported'}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Hardware
              </dt>
              <dd className="mt-1 break-words text-sm">{record.backend ?? 'Not reported'}</dd>
            </div>
          </dl>
        )}
      </div>
      {raw ? (
        <div>
          <CopyButton text={JSON.stringify(visible, null, 2)} label="Copy visible data" />
          <pre className="mt-3 max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs">
            {JSON.stringify(visible, null, 2)}
          </pre>
        </div>
      ) : (
        <>
          {record.error && display.response && (
            <p role="status" className="border-l-2 border-border bg-muted/30 p-3 text-xs">
              {record.error}
            </p>
          )}
          {display.request && (
            <>
              <Payload title="Request" value={record.request} />
              {record.effectiveRequest !== undefined && (
                <details className="border-t border-border pt-3">
                  <summary className="text-xs">Effective request / parameters</summary>
                  <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(record.effectiveRequest, null, 2)}
                  </pre>
                </details>
              )}
            </>
          )}
          {display.response && <Payload title="Response" value={record.response} />}
          {display.details && (
            <section className="space-y-2 border-t border-border pt-3">
              <h3 className="text-sm font-normal">Generation details</h3>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <dt className="text-muted-foreground">Total elapsed</dt>
                <dd>{duration(record.durationMs)}</dd>
                {Object.entries(record.metrics ?? {}).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="break-words text-muted-foreground">{key}</dt>
                    <dd className="break-all">
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">
                Unavailable runtime metrics are not estimated.
              </p>
            </section>
          )}
        </>
      )}
      {attachments.map((asset) => (
        <Attachment key={`${record.id}-${asset.id}`} recordId={record.id} asset={asset} />
      ))}
      {display.details && related.length > 0 && (
        <section className="space-y-2 border-t border-border pt-3">
          <h3 className="text-sm font-normal">Related requests / attempts</h3>
          {related.map((row) => (
            <RelatedRequest key={row.id} row={row} display={display} />
          ))}
        </section>
      )}
      <p className="break-all text-[11px] text-muted-foreground">
        {record.id}
        {record.parentId ? ` · Parent ${record.parentId}` : ''}
      </p>
    </div>
  )
}

function RelatedRequest({
  row,
  display
}: {
  row: AIRequestSummary
  display: Display
}): React.ReactElement {
  const [record, setRecord] = useState<AIRequestRecord | null>(null)
  const [error, setError] = useState('')
  return (
    <details
      className="border-b border-border py-2"
      onToggle={(event) => {
        if (event.currentTarget.open && !record)
          void window.api
            .aiLogsDetail(row.id)
            .then((value) => {
              setRecord(value)
              if (!value) setError('This request is no longer available.')
            })
            .catch((error) => setError(errorMessage(error)))
      }}
    >
      <summary className="text-xs">
        {row.source} · {row.status} · {duration(row.durationMs)}
        {display.model ? ` · ${row.backend ?? 'Backend not reported'}` : ''}
      </summary>
      <div className="mt-3 space-y-3">
        {error && (
          <p role="alert" className="text-xs">
            {error}
          </p>
        )}
        {record && (
          <>
            {display.request && <Payload title="Request" value={record.request} />}
            {display.response && (
              <Payload title="Response" value={record.response ?? record.error} />
            )}
          </>
        )}
      </div>
    </details>
  )
}

export function AIRequestLogs({
  standalone = false
}: {
  standalone?: boolean
}): React.ReactElement {
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [modality, setModality] = useState('all')
  const [status, setStatus] = useState('all')
  const [hardware, setHardware] = useState('all')
  const [sort, setSort] = useState('newest')
  const [period, setPeriod] = useState('all')
  const [slow, setSlow] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [display, setDisplay] = useState<Display>(readDisplay)
  const [raw, setRaw] = useState(false)
  const [live, setLive] = useState(true)
  const [offset, setOffset] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [page, setPage] = useState<AILogPage>({ rows: [], total: 0 })
  const [record, setRecord] = useState<AIRequestRecord | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    setOffset(0)
  }, [debouncedSearch, modality, status, hardware, sort, period, slow])
  const query = useMemo<AILogQuery>(
    () => ({
      search: debouncedSearch,
      modality: modality === 'all' ? undefined : (modality as AILogQuery['modality']),
      status: status === 'all' ? undefined : (status as AILogQuery['status']),
      hardware: hardware === 'all' ? undefined : (hardware as AILogQuery['hardware']),
      sort: sort as AILogQuery['sort'],
      minDurationMs: slow ? 10000 : undefined,
      offset,
      limit: 30
    }),
    [debouncedSearch, modality, status, hardware, sort, slow, offset]
  )
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const active = (): boolean => !disposed
    async function load(): Promise<void> {
      try {
        const result = await window.api.aiLogsList({
          ...query,
          since:
            period === 'hour'
              ? Date.now() - 3600000
              : period === 'day'
                ? Date.now() - 86400000
                : undefined
        })
        if (disposed) return
        setPage(result)
        setError('')
        const selected = result.rows.some((row) => row.id === selectedId)
          ? selectedId
          : (result.rows[0]?.id ?? null)
        if (selected !== selectedId) {
          setRecord(null)
          setSelectedId(selected)
        } else if (selected) {
          const detail = await window.api.aiLogsDetail(selected)
          if (active()) setRecord(detail)
        } else setRecord(null)
      } catch (error) {
        if (!disposed) setError(errorMessage(error))
      } finally {
        if (!disposed) {
          setLoading(false)
          if (live)
            timer = setTimeout(() => {
              if (document.visibilityState === 'hidden') timer = setTimeout(() => void load(), 2000)
              else void load()
            }, 2000)
        }
      }
    }
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [query, selectedId, period, live, refresh])
  function toggleDisplay(key: keyof Display): void {
    const next = { ...display, [key]: !display[key] }
    setDisplay(next)
    try {
      window.localStorage.setItem('ai-activity-display', JSON.stringify(next))
    } catch {
      /* Preference storage may be unavailable. */
    }
  }
  async function clear(): Promise<void> {
    setClearing(true)
    try {
      await window.api.aiLogsClear()
      setPage({ rows: [], total: 0 })
      setRecord(null)
      setSelectedId(null)
      setOffset(0)
      setConfirmClear(false)
      setRefresh((value) => value + 1)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setClearing(false)
    }
  }
  return (
    <section
      aria-label="AI activity"
      className={`flex w-full min-w-0 flex-col gap-3 overflow-auto font-mono text-foreground ${standalone ? 'h-full flex-1 bg-background p-6' : 'h-[calc(100dvh-18rem)] min-h-96'}`}
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          {standalone && <h1 className="text-lg font-normal">AI activity</h1>}
          <p className="mt-1 text-xs text-muted-foreground">
            Inspect your AI requests and responses.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={live}
            className={live ? 'text-primary' : 'text-muted-foreground'}
            onClick={() => setLive((value) => !value)}
          >
            {live ? <Pulse aria-hidden /> : <Pause aria-hidden />}
            Live updates
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Refresh activity"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <ArrowClockwise />
          </Button>
          {!standalone && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void window.api.aiLogsOpenWindow().catch((error) => setError(errorMessage(error)))
              }
            >
              <ArrowSquareOut />
              Open in new window
            </Button>
          )}
        </div>
      </header>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <label
          data-focus-surface
          className="flex min-w-48 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3"
        >
          <MagnifyingGlass aria-hidden />
          <input
            aria-label="Search requests and responses"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search requests, responses, models..."
            className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none"
          />
        </label>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={showFilters}
          aria-controls="ai-log-filters"
          onClick={() => setShowFilters((value) => !value)}
        >
          <SlidersHorizontal />
          Filters
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <Eye />
              Show
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="shadow-none">
            <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
              Visible fields
            </DropdownMenuLabel>
            {(Object.keys(display) as (keyof Display)[]).map((key) => (
              <DropdownMenuCheckboxItem
                key={key}
                checked={display[key]}
                onCheckedChange={() => toggleDisplay(key)}
                onSelect={(event) => event.preventDefault()}
              >
                {
                  {
                    request: 'Requests',
                    response: 'Responses',
                    model: 'Model & hardware',
                    details: 'Generation details'
                  }[key]
                }
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {showFilters && (
        <div
          id="ai-log-filters"
          className="flex shrink-0 flex-wrap items-end gap-3 rounded-md border border-border bg-muted/20 p-3"
        >
          <Filter
            label="Status"
            value={status}
            onChange={setStatus}
            options={['all', 'running', 'completed', 'failed', 'cancelled', 'interrupted']}
          />
          <Filter
            label="Hardware"
            value={hardware}
            onChange={setHardware}
            options={['all', 'gpu', 'cpu', 'unknown']}
          />
          <Filter
            label="Time"
            value={period}
            onChange={setPeriod}
            options={['all', 'hour', 'day']}
          />
          <label className="flex items-center gap-2 py-2 text-xs">
            <input
              type="checkbox"
              className="accent-primary"
              checked={slow}
              onChange={(event) => setSlow(event.target.checked)}
            />
            Over 10 seconds
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch('')
              setStatus('all')
              setHardware('all')
              setPeriod('all')
              setSlow(false)
              setModality('all')
            }}
          >
            Reset filters
          </Button>
        </div>
      )}
      <div className="flex shrink-0 flex-wrap gap-1" role="group" aria-label="Modality">
        <Button
          variant={modality === 'all' ? 'secondary' : 'ghost'}
          size="sm"
          aria-pressed={modality === 'all'}
          className={modality === 'all' ? 'text-primary' : 'text-muted-foreground'}
          onClick={() => setModality('all')}
        >
          All
        </Button>
        {AI_MODALITIES.map((kind) => (
          <Button
            key={kind}
            variant={modality === kind ? 'secondary' : 'ghost'}
            size="sm"
            aria-pressed={modality === kind}
            className={modality === kind ? 'text-primary' : 'text-muted-foreground'}
            onClick={() => setModality(kind)}
          >
            {labels[kind]}
          </Button>
        ))}
      </div>
      {(error || page.storageError) && (
        <p role="alert" className="rounded-md border border-border p-3 text-xs">
          {error || page.storageError}
        </p>
      )}
      <div className="grid min-h-64 min-w-0 flex-1 grid-cols-1 overflow-auto rounded-md border border-border bg-background md:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)] md:overflow-hidden">
        <div
          aria-label="Request list"
          role="region"
          className="flex min-h-64 min-w-0 flex-col overflow-hidden border-b border-border md:min-h-0 md:border-r md:border-b-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3">
            <span
              aria-live="polite"
              className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground"
            >
              {page.total} requests
            </span>
            <div className="min-w-0 max-w-44">
              <SettingsSelect
                id="ai-log-sort"
                label="Sort requests"
                value={sort}
                onValueChange={setSort}
                options={[
                  { value: 'newest', label: 'Newest first' },
                  { value: 'oldest', label: 'Oldest first' },
                  { value: 'slowest', label: 'Slowest first' }
                ]}
              />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
            {loading && (
              <p role="status" className="p-4 text-xs text-muted-foreground">
                Loading activity...
              </p>
            )}
            {!loading && !page.rows.length && (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
                <ListMagnifyingGlass aria-hidden className="size-6 text-muted-foreground" />
                <p className="max-w-xs text-sm text-muted-foreground">
                  {search ||
                  modality !== 'all' ||
                  status !== 'all' ||
                  hardware !== 'all' ||
                  slow ||
                  period !== 'all'
                    ? 'No requests match these filters.'
                    : 'No activity yet. Your next AI request will appear here.'}
                </p>
              </div>
            )}
            <div>
              {page.rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  aria-pressed={selectedId === row.id}
                  onClick={() => {
                    setRecord(null)
                    setSelectedId(row.id)
                  }}
                  className={`block w-full border-b border-l-2 border-b-border px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${selectedId === row.id ? 'border-l-primary bg-primary/5' : 'border-l-transparent'}`}
                >
                  <span className="flex justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>
                      {labels[row.modality]}
                      {row.source ? ` · ${row.source}` : ''}
                      {row.parentId ? ' · Attempt / child' : ''}
                    </span>
                    <time>{new Date(row.startedAt).toLocaleTimeString()}</time>
                  </span>
                  <span className="my-1 block truncate text-sm">{row.preview || row.source}</span>
                  <span className="flex justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {display.model ? (row.model ?? row.source) : row.source}
                    </span>
                    {display.details && (
                      <span className="shrink-0">{duration(row.durationMs)}</span>
                    )}
                  </span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {row.status}
                    {display.model ? ` · ${row.backend ?? 'Backend not reported'}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => setOffset((value) => Math.max(0, value - 30))}
            >
              Previous
            </Button>
            <span className="text-[11px] text-muted-foreground">
              {page.total ? `${offset + 1}-${Math.min(offset + 30, page.total)}` : '0'}
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={offset + 30 >= page.total}
              onClick={() => setOffset((value) => value + 30)}
            >
              Next
            </Button>
          </div>
        </div>
        <div
          role="region"
          aria-label="Request details"
          className="flex min-h-64 min-w-0 flex-col overflow-hidden md:min-h-0"
        >
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-3">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Request details
            </span>
            {record && (
              <div className="flex gap-1">
                <Button
                  size="xs"
                  variant={raw ? 'ghost' : 'secondary'}
                  aria-pressed={!raw}
                  onClick={() => setRaw(false)}
                >
                  Readable
                </Button>
                <Button
                  size="xs"
                  variant={raw ? 'secondary' : 'ghost'}
                  aria-pressed={raw}
                  onClick={() => setRaw(true)}
                >
                  Raw
                </Button>
              </div>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-5">
            {record ? (
              <RequestDetail key={record.id} record={record} display={display} raw={raw} />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
                <ListMagnifyingGlass aria-hidden className="size-6" />
                <p className="text-sm">
                  {selectedId ? 'Loading request...' : 'Select a request to inspect it.'}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <div className="max-w-xl space-y-1">
          <p className="flex items-center gap-2">
            <HardDrives />
            Local history · Up to {AI_LOG_POLICY.maxAgeDays} days /{' '}
            {AI_LOG_POLICY.maxRecords.toLocaleString()} requests / 256 MB
          </p>
          <details>
            <summary className="w-fit cursor-pointer hover:text-foreground">
              Storage details
            </summary>
            <p className="mt-2">
              Large payloads are marked when truncated. Media up to 8 MB is retained. Clearing logs
              does not delete your chats.
            </p>
          </details>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setConfirmClear(true)}>
          <Trash />
          Clear history
        </Button>
      </footer>
      {confirmClear && (
        <div
          role="group"
          aria-label="Confirm clear activity"
          className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
        >
          <p className="flex-1 text-sm">Delete all saved AI activity and its media?</p>
          <Button
            size="sm"
            variant="outline"
            disabled={clearing}
            onClick={() => setConfirmClear(false)}
          >
            Cancel
          </Button>
          <Button size="sm" variant="destructive" disabled={clearing} onClick={() => void clear()}>
            {clearing ? 'Clearing...' : 'Delete history'}
          </Button>
        </div>
      )}
    </section>
  )
}

function Filter({
  label,
  value,
  onChange,
  options
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: string[]
}): React.ReactElement {
  const names: Record<string, string> = {
    all: 'Any',
    gpu: 'GPU',
    cpu: 'CPU',
    hour: 'Last hour',
    day: 'Last 24 hours',
    unknown: 'Not reported'
  }
  return (
    <label className="flex min-w-32 flex-col gap-1 text-xs text-muted-foreground">
      <span className="text-[11px] uppercase tracking-wide">{label}</span>
      <select
        aria-label={label}
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {names[option] ?? option}
          </option>
        ))}
      </select>
    </label>
  )
}
