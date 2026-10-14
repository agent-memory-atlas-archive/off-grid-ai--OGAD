import { useEffect } from 'react'

/**
 * A nested popup owns the first Escape press. Radix portals the popup to document.body, so
 * checking the event path is more reliable than checking whether the popup is a DOM child of the
 * panel. Focus can also stay on the control that opened the popup (a searchable combobox keeps it
 * in its input, a select holds it on the trigger until the list takes it), so an Escape from a
 * control whose popup is open belongs to that popup too.
 */
export function isNestedPopupEscape(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[role="menu"], [role="listbox"], [aria-haspopup][aria-expanded="true"]') !==
      null
  )
}

// Dismiss-on-Escape for overlays/panels/slide-overs. One place so every panel dismisses
// the same way (Escape closes), instead of each re-implementing a keydown listener.
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (isNestedPopupEscape(e.target)) return

      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}
