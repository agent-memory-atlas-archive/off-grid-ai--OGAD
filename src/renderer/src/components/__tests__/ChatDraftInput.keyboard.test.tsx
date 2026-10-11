// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatDraftInput } from '../ChatDraftInput'
import { createChatDraftStore } from '../chat-draft-store'

afterEach(cleanup)

function Composer({
  attachmentPending = false
}: {
  attachmentPending?: boolean
}): React.JSX.Element {
  const [store] = useState(() => createChatDraftStore())
  const [result, setResult] = useState('')
  const submit = (mode: string): void => {
    setResult(`${mode}: ${store.getSnapshot()}`)
    store.set('')
  }
  return (
    <>
      <ChatDraftInput
        store={store}
        skills={[{ name: 'summarize', description: 'Summarize text' }]}
        mode="ask"
        busy
        attachmentPending={attachmentPending}
        onPaste={() => {}}
        onSubmit={() => submit('Queued')}
        onSendNow={() => submit('Send now')}
      />
      <output>{result}</output>
    </>
  )
}

describe('chat composer keyboard', () => {
  it('queues with Enter and sends now with Command or Control plus Enter', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const input = screen.getByRole('textbox')
    await user.type(input, 'First{Enter}')
    expect(screen.getByRole('status').textContent).toBe('Queued: First')
    await user.type(input, 'Priority')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(screen.getByRole('status').textContent).toBe('Send now: Priority')
    await user.type(input, 'Control')
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(screen.getByRole('status').textContent).toBe('Send now: Control')
  })

  it('keeps Shift+Enter as a new line and Enter as skill completion', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.type(input, '/summ{Enter}')
    expect(input.value).toBe('/summarize ')
    expect(screen.getByRole('status').textContent).toBe('')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(input.value).toBe('/summarize \n')
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('keeps a draft while its attachment is being read', async () => {
    const user = userEvent.setup()
    render(<Composer attachmentPending />)
    const input = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.type(input, 'Attached{Enter}')
    await user.keyboard('{Meta>}{Enter}{/Meta}')
    expect(input.value).toBe('Attached')
    expect(screen.getByRole('status').textContent).toBe('')
  })
})
