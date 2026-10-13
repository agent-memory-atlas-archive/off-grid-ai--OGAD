import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { useEscapeToClose } from '@renderer/lib/use-escape-to-close'
import { acquireNativeSurfaceOcclusion } from '@renderer/lib/native-surface-occlusion'

type SidePanelProps = {
  ariaLabel: string
  children: ReactNode
  onClose: () => void
  className?: string
  style?: CSSProperties
  restoreFocusRef?: RefObject<HTMLElement | null>
  modal?: boolean
}

/**
 * Shared frame for dismissible Desktop side panels.
 *
 * Dressed as the library's sheet (animate/sheet in the overlays chapter): a glass layer over the
 * living background that arrives on the same spring. It stays OGAD's own frame because callers
 * mount and unmount it (exit runs in their AnimatePresence), it must sit above every other
 * renderer layer, it can be non-modal, and it holds native child views below it.
 *
 * The backdrop owns outside-click dismissal and the shared hook owns Escape.
 * Content stays in a sibling dialog, so clicks inside never reach the backdrop.
 */
export function SidePanel({
  ariaLabel,
  children,
  onClose,
  className = '',
  style,
  restoreFocusRef,
  modal = true
}: SidePanelProps): React.JSX.Element {
  useEscapeToClose(onClose)
  const reduceMotion = useReducedMotion()
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => acquireNativeSurfaceOcclusion(), [])

  useLayoutEffect(() => {
    const previousFocus =
      restoreFocusRef?.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    const panel = panelRef.current
    panel?.focus()

    const trapFocus = (event: KeyboardEvent): void => {
      if (!modal || event.key !== 'Tab' || !panel) return
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => {
        const computedStyle = window.getComputedStyle(element)
        return (
          !element.matches(':disabled') &&
          !element.hasAttribute('hidden') &&
          element.getAttribute('aria-hidden') !== 'true' &&
          computedStyle.display !== 'none' &&
          computedStyle.visibility !== 'hidden'
        )
      })
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }

    panel?.addEventListener('keydown', trapFocus)
    return () => {
      panel?.removeEventListener('keydown', trapFocus)
      if (modal || panel?.contains(document.activeElement)) previousFocus?.focus()
    }
  }, [restoreFocusRef, modal])

  return createPortal(
    <div className="pointer-events-none" data-testid="side-panel-layer">
      {modal && (
        <motion.div
          className="pointer-events-auto fixed inset-0 z-[2147483646] bg-black/30 backdrop-blur-[2px]"
          onClick={onClose}
          aria-hidden="true"
          data-testid="side-panel-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.32, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
      <motion.div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={modal || undefined}
        aria-label={ariaLabel}
        className={`pointer-events-auto fixed inset-y-0 right-0 z-[2147483647] flex max-w-full flex-col border-l border-border/60 bg-background/85 font-mono shadow-2xl backdrop-blur-xl ${className}`}
        style={style}
        initial={reduceMotion ? false : { x: '100%', opacity: 0.7 }}
        animate={{ x: '0%', opacity: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { x: '100%', opacity: 0.7 }}
        // The page recedes while the panel arrives on a spring, as the library's sheet does.
        transition={
          reduceMotion
            ? { duration: 0 }
            : { type: 'spring', stiffness: 380, damping: 38, mass: 0.9 }
        }
      >
        {children}
      </motion.div>
    </div>,
    document.body
  )
}
