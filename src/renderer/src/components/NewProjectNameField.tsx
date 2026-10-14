import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Input } from '@offgrid/operator-ui/operator/coss/input'

/**
 * Focus lands AFTER the dropdown returns focus to its trigger. Without the delay, Radix's
 * focus-return blurs the input immediately and its blur handler tears the field down before the
 * user can type. The menu now animates out (~200ms) and keeps trapping focus until it is gone,
 * so the delay has to outlast that exit.
 */
const FOCUS_DELAY_MS = 300

interface NewProjectNameFieldProps {
  /** Create the project with this name. Called on Enter and on blur, as it always has been. */
  readonly onCreate: (name: string) => void
  readonly onCancel: () => void
}

/**
 * The inline "new project" name field in the composer.
 *
 * The name lived in the chat screen, so naming a project re-rendered the transcript on every
 * character. It lives here now: the screen is handed the finished name once, when the user
 * commits it.
 */
export function NewProjectNameField({
  onCreate,
  onCancel
}: NewProjectNameFieldProps): React.JSX.Element {
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), FOCUS_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <motion.div
      className="mb-2"
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <Input
        ref={input}
        size="sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCreate(name)
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => onCreate(name)}
        placeholder="New project name…  (Enter to create, Esc to cancel)"
        className="text-xs"
      />
    </motion.div>
  )
}
