// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useEscapeToClose } from '../use-escape-to-close'

function Panel({ onClose }: { onClose: () => void }): React.ReactElement {
  useEscapeToClose(onClose)
  return <div>panel</div>
}

describe('useEscapeToClose', () => {
  afterEach(cleanup)

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<Panel onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const onClose = vi.fn()
    render(<Panel onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lets an open nested picker handle the first Escape press', () => {
    const onClose = vi.fn()
    const { container } = render(
      <>
        <Panel onClose={onClose} />
        <div role="menu">
          <button type="button">Choice</button>
        </div>
      </>
    )

    fireEvent.keyDown(container.querySelector('[role="menu"]')!, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('lets a picker that keeps focus on its own control handle Escape while its list is open', () => {
    let closes = 0
    const { getByRole, rerender } = render(
      <>
        <Panel onClose={() => (closes += 1)} />
        <input role="combobox" aria-label="Model" aria-haspopup="listbox" aria-expanded="true" />
      </>
    )

    fireEvent.keyDown(getByRole('combobox', { name: 'Model' }), { key: 'Escape' })
    expect(closes).toBe(0)

    rerender(
      <>
        <Panel onClose={() => (closes += 1)} />
        <input role="combobox" aria-label="Model" aria-haspopup="listbox" aria-expanded="false" />
      </>
    )
    fireEvent.keyDown(getByRole('combobox', { name: 'Model' }), { key: 'Escape' })
    expect(closes).toBe(1)
  })

  it('unsubscribes on unmount (no close after the panel is gone)', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Panel onClose={onClose} />)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
