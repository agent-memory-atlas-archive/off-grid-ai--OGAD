import { useState } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import { captureUrlForPath } from '../../../../shared/ogcapture-url'
import type { ComputerUseStepDetail } from '@renderer/lib/task-session-store'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '@renderer/components/ui/collapsible'
import { ImageLightbox } from '@renderer/components/media/ImageLightbox'

function dimensions(detail: ComputerUseStepDetail): string | null {
  const frame = detail.screenshot
  if (!frame) return null
  return `${frame.originalWidth} x ${frame.originalHeight} source | ${frame.inferenceWidth} x ${frame.inferenceHeight} model input`
}

function tokenSummary(detail: ComputerUseStepDetail): string | null {
  const usage = detail.tokenUsage
  if (!usage) return null
  return [
    usage.input !== undefined ? `${usage.input} input` : null,
    usage.output !== undefined ? `${usage.output} output` : null,
    usage.context !== undefined ? `${usage.context} context` : null
  ]
    .filter(Boolean)
    .join(' | ')
}

function DetailBlock({
  label,
  value
}: Readonly<{ label: string; value?: string }>): React.JSX.Element | null {
  if (!value) return null
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
      <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
        {value}
      </pre>
    </div>
  )
}

export function ComputerUseStepDetails({
  details,
  showScreenshots = true
}: Readonly<{
  details: readonly ComputerUseStepDetail[] | undefined
  showScreenshots?: boolean
}>): React.JSX.Element | null {
  const [selectedScreenshot, setSelectedScreenshot] = useState<{ url: string; alt: string } | null>(
    null
  )
  if (!details?.length) return null
  return (
    <>
      <div className="mt-3 space-y-0.5 border-t border-border pt-3">
        <p className="mb-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">
          Computer Use details
        </p>
        {details.map((detail, index) => {
          const timing = detail.execution?.durationMs
          const tokens = tokenSummary(detail)
          const screenshotIsLocal =
            Boolean(detail.screenshot?.path) && detail.screenshot?.availability !== 'unavailable'
          const deviceName = detail.screenshot?.executionDeviceName
          const stepSummary =
            detail.decisionSummary ||
            detail.mappedAction ||
            detail.execution?.result ||
            detail.stepId
          return (
            <Collapsible key={`${detail.stepId}:${detail.at}:${index}`}>
              <CollapsibleTrigger
                className="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs text-muted-foreground transition-colors duration-300 hover:bg-foreground/[0.035] hover:text-foreground data-[state=open]:text-foreground"
                aria-label={`Computer Use step ${index + 1}: ${stepSummary}, ${detail.phase ?? detail.execution?.status ?? 'recorded'}`}
              >
                <span className="min-w-0 flex-1 truncate transition-transform duration-300 group-hover:translate-x-0.5">
                  Step {index + 1} | {stepSummary}
                </span>
                <span
                  className={`shrink-0 font-mono text-[11px] tabular-nums ${
                    detail.execution?.status === 'failed' ? 'text-red-500' : 'text-muted-foreground'
                  }`}
                >
                  {timing !== undefined ? `${Math.round(timing)} ms | ` : ''}
                  {detail.phase ?? detail.execution?.status ?? 'recorded'}
                </span>
                <CaretDown
                  className="h-3 w-3 shrink-0 transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent className="ml-1.5 space-y-3 border-l border-border py-3 pl-4">
                {showScreenshots && screenshotIsLocal && detail.screenshot?.path ? (
                  <button
                    type="button"
                    className="group/shot block w-full cursor-zoom-in overflow-hidden rounded-lg focus:outline-none focus:ring-1 focus:ring-green-500"
                    aria-label={`Open screenshot for Computer Use step ${index + 1}`}
                    onClick={() =>
                      setSelectedScreenshot({
                        url: captureUrlForPath(detail.screenshot!.path!),
                        alt: `Computer Use step ${index + 1}`
                      })
                    }
                  >
                    <img
                      src={captureUrlForPath(detail.screenshot.path)}
                      alt={`Computer Use step ${index + 1}`}
                      className="max-h-40 w-full object-contain transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/shot:scale-[1.02]"
                      loading="lazy"
                      decoding="async"
                      fetchPriority="low"
                    />
                  </button>
                ) : showScreenshots && detail.screenshot ? (
                  <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
                    Screenshot stays on {deviceName || 'the execution device'}.
                  </p>
                ) : null}
                {dimensions(detail) ? (
                  <p className="text-xs text-muted-foreground">{dimensions(detail)}</p>
                ) : null}
                {tokens ? <p className="text-xs text-muted-foreground">Tokens: {tokens}</p> : null}
                <DetailBlock
                  label="Retrieved facts and context"
                  value={detail.retrievedFacts?.join('\n')}
                />
                <DetailBlock label="Decision summary" value={detail.decisionSummary} />
                <DetailBlock label="Execution result" value={detail.execution?.result} />
                <DetailBlock label="Error" value={detail.execution?.error} />
              </CollapsibleContent>
            </Collapsible>
          )
        })}
      </div>
      <ImageLightbox
        image={
          selectedScreenshot
            ? { ...selectedScreenshot, dialogLabel: 'Task screenshot preview' }
            : null
        }
        onClose={() => setSelectedScreenshot(null)}
      />
    </>
  )
}
