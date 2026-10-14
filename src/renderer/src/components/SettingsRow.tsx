import type { ReactNode } from 'react'

export function SettingsRow({
  label,
  hint,
  value,
  controlId,
  inline = false,
  children
}: {
  label: string
  hint?: string
  value?: string
  controlId?: string
  /** A compact control (switch, select, short segmented) sits on the label's line, at the
   * right. Wide controls - sliders, text fields, long button sets - keep their own line. */
  inline?: boolean
  children: ReactNode
}): React.JSX.Element {
  // Title, one line on what it does, then the control: the same reading order on every row.
  const title = (
    <div className="flex items-baseline justify-between gap-4">
      <label htmlFor={controlId} className="text-[13px] text-neutral-200">
        {label}
      </label>
      {value !== undefined ? (
        <span className="shrink-0 text-xs tabular-nums text-green-500">{value}</span>
      ) : null}
    </div>
  )
  const description = hint ? (
    <p className="mt-0.5 text-[11.5px] leading-snug text-neutral-500">{hint}</p>
  ) : null
  if (inline) {
    return (
      <div className="flex items-center justify-between gap-4 py-2.5 first:pt-1">
        <div className="min-w-0 flex-1">
          {title}
          {description}
        </div>
        {/* Library selects fill their parent, so the slot has a floor; a switch hugs the edge. */}
        <div className="flex min-w-36 max-w-[55%] shrink-0 justify-end">{children}</div>
      </div>
    )
  }
  return (
    <div className="py-2.5 first:pt-1">
      {title}
      {description}
      <div className="mt-2">{children}</div>
    </div>
  )
}
