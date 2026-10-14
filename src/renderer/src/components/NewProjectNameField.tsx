import { useState, type Ref } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Input } from '@offgrid/operator-ui/operator/coss/input'

interface NewProjectNameFieldProps {
  readonly inputRef: Ref<HTMLInputElement>
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
  inputRef,
  onCreate,
  onCancel
}: NewProjectNameFieldProps): React.JSX.Element {
  const [name, setName] = useState('')
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      className="mb-2"
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <Input
        ref={inputRef}
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
