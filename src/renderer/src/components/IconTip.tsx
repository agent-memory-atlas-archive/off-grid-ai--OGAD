import type { ReactElement, ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@renderer/components/ui/tooltip'

/**
 * The library tooltip around an icon-only control. The icon button keeps its old visible label as
 * `aria-label`; this shows the same words on hover/focus. It carries its own provider so it renders
 * in any tree (the app root already has one; isolated screens and panels may not).
 */
export function IconTip({
  label,
  children
}: {
  label: ReactNode
  children: ReactElement
}): ReactElement {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/**
 * Morphs one glyph into the next when an icon button changes state (play to pause, copy to check,
 * idle to spinner) instead of swapping words. Respects reduced motion.
 */
export function GlyphSwap({
  glyphKey,
  children
}: {
  glyphKey: string
  children: ReactNode
}): ReactElement {
  const reduceMotion = useReducedMotion()
  return (
    <span className="relative grid place-items-center">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={glyphKey}
          className="flex"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: -45 }}
          animate={{ opacity: 1, scale: 1, rotate: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.5, rotate: 45 }}
          transition={
            reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 28 }
          }
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
