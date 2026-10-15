import { useEffect, useState } from 'react'
import { Sun, Moon, Monitor } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { cn } from '@renderer/lib/utils'
import { getThemeMode, onThemeModeChanged, setThemeMode, type ThemeMode } from '../theme'

// Theme switch (system -> light -> dark -> system).
const ORDER: ThemeMode[] = ['system', 'light', 'dark']
const ICON = { system: Monitor, light: Sun, dark: Moon }
const LABEL = { system: 'System', light: 'Light', dark: 'Dark' }

/** Theme cycle styled as a left-nav item (icon-only when collapsed, icon+label
 *  when expanded) — matches the other nav buttons in App.tsx. */
export function NavThemeToggle({ expanded }: { expanded: boolean }): React.ReactElement {
  const [mode, setMode] = useState<ThemeMode>(getThemeMode())
  const reduceMotion = useReducedMotion()
  useEffect(() => onThemeModeChanged(setMode), [])
  const Icon = ICON[mode]
  const cycle = (): void => {
    const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]!
    setThemeMode(next)
    setMode(next)
  }
  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${LABEL[mode]}`}
      title={!expanded ? `Theme: ${LABEL[mode]}` : undefined}
      data-slot="button"
      className={cn(
        'group/nav relative flex items-center gap-3 rounded-lg py-2 text-sm',
        expanded ? 'px-3' : 'justify-center px-0',
        'text-neutral-500 hover:bg-neutral-500/10 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white'
      )}
    >
      {/* The glyph turns into the next one instead of swapping, like the library's reveal toggle. */}
      <span className="relative grid h-5 w-5 shrink-0 place-items-center">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={mode}
            className="flex"
            initial={{ opacity: 0, scale: 0.5, rotate: -45 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0, scale: 0.5, rotate: 45 }}
            transition={
              reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 28 }
            }
          >
            <Icon className="h-5 w-5" />
          </motion.span>
        </AnimatePresence>
      </span>
      {expanded && (
        <TextMorph as="span" className="flex-1 text-left whitespace-pre">
          {`Theme: ${LABEL[mode]}`}
        </TextMorph>
      )}
    </button>
  )
}
