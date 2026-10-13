import type { ReactNode } from 'react'

export function SettingsRow({
  label,
  hint,
  value,
  controlId,
  children
}: {
  label: string
  hint?: string
  value?: string
  controlId?: string
  children: ReactNode
}): React.JSX.Element {
  // Title, one line on what it does, then the control: the same reading order on every row.
  return (
    <div className="py-4 first:pt-1">
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={controlId} className="text-[13px] text-neutral-200">
          {label}
        </label>
        {value !== undefined ? (
          <span className="shrink-0 text-xs tabular-nums text-green-500">{value}</span>
        ) : null}
      </div>
      {hint ? <p className="mt-1 text-[11.5px] leading-relaxed text-neutral-500">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </div>
  )
}
