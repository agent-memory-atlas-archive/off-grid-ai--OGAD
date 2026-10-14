// @vitest-environment jsdom
//
// A Chat comic-book run answers with a long visible plan (a continuity bible and one prompt per
// page) and then generates its pages one at a time. The plan must be readable as soon as the text
// turn finishes, above the comic reader, while the pages are still generating - not only after the
// last page lands or the user presses Stop. It must also appear exactly once, during the run, after
// it, after Stop, and after a reload.
//
// Mounts the real MemoryChat over the stateful preload boundary used by the chat lifecycle suite;
// only window.api (Electron IPC, the model and the image runtime) is faked.

import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTaskSessionStoreForTests } from '../../lib/task-session-store'
import { clearRegisteredSlots } from '../../bootstrap/slotRegistry'
import { ChatBoundary, installBoundary, renderChat, send } from './harness/chat-boundary'

const COMIC_REQUEST =
  '<!-- offgrid-action:comic-book -->\nQ: Story brief\nA: Mira repairs the lighthouse.\nQ: Story length\nA: 10 distinct images'

const PLAN = [
  'Continuity Bible',
  'Mira keeps a red scarf and brass goggles on every page.',
  'Page 1 Prompt: Mira climbs the lighthouse stairs at dusk.',
  'Page 2 Prompt: Mira opens the lamp room and finds the broken lens.',
  'Page 3 Prompt: The repaired light sweeps across the harbour.',
  'The complete comic book structure has been created and the pages are generating.'
].join('\n\n')

const PAGE_REQUESTS = [1, 2, 3].map((page) => ({
  prompt: `BOOK TITLE: Lighthouse Mira\nPAGE STORY: Page ${page} of the repair.\nILLUSTRATION: Page ${page}, finished comic page.`,
  enhancePrompt: false
}))

type PendingImage = { resolve: (page: number) => void; reject: (error: Error) => void }

// Pages still generating when a test ends, finished so no run outlives its test.
const openPages: PendingImage[] = []
const STOP = /^stop( generating)?$/i

function installComicBoundary(): { boundary: ChatBoundary; pages: PendingImage[] } {
  const boundary = new ChatBoundary()
  installBoundary(boundary)
  const pages: PendingImage[] = []
  window.api.generateImage = (() =>
    new Promise((resolve, reject) => {
      const page: PendingImage = {
        resolve: (page) =>
          resolve({
            path: `/generated/comic-page-${page}.png`,
            dataUrl: 'data:image/png;base64,AA==',
            seed: page,
            syncId: `comic-page-${page}`,
            model: 'test-image',
            prompt: `Page ${page}, finished comic page.`
          }),
        reject
      }
      pages.push(page)
      openPages.push(page)
    })) as typeof window.api.generateImage
  window.api.cancelImageGen = (async () => {
    for (const page of pages) page.reject(new Error('Image generation cancelled.'))
  }) as typeof window.api.cancelImageGen
  window.api.keepInitImage = (async () => null) as unknown as typeof window.api.keepInitImage
  window.api.deleteArtifact = async () => true
  return { boundary, pages }
}

async function startComicRun(
  boundary: ChatBoundary,
  pages: PendingImage[],
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await send(COMIC_REQUEST, user)
  await waitFor(() => expect(boundary.calls).toHaveLength(1))
  await act(async () => {
    boundary.emit(0, PLAN)
    boundary.resolve(0, PLAN, {
      toolCalls: PAGE_REQUESTS.map(() => ({
        name: 'generate_image',
        result: 'Image generation started',
        status: 'completed' as const
      })),
      imageRequests: PAGE_REQUESTS
    })
  })
  await waitFor(() => expect(pages).toHaveLength(1))
  await act(async () => pages[0]!.resolve(1))
  await waitFor(() => expect(pages).toHaveLength(2))
}

function expectPlanShownOnce(): void {
  expect(
    screen.getAllByText('Mira keeps a red scarf and brass goggles on every page.')
  ).toHaveLength(1)
  expect(
    screen.getAllByText(
      'The complete comic book structure has been created and the pages are generating.'
    )
  ).toHaveLength(1)
}

function expectPlanAboveReader(readerText: string): void {
  const plan = screen.getByText('Mira keeps a red scarf and brass goggles on every page.')
  const reader = screen.getByText(readerText)
  expect(plan.compareDocumentPosition(reader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
}

describe('<MemoryChat/> - comic book answer stays visible while pages generate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
    resetTaskSessionStoreForTests()
  })

  afterEach(async () => {
    while (openPages.length) {
      await act(async () => {
        for (const page of openPages.splice(0))
          page.reject(new Error('Image generation cancelled.'))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    }
    cleanup()
    vi.unstubAllGlobals()
    clearRegisteredSlots()
  })

  it('shows the plan above the reader while page 2 is still generating', async () => {
    const { boundary, pages } = installComicBoundary()
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await startComicRun(boundary, pages, user)

    expect(await screen.findByText('Comic book reader: 1 of 10 pages ready.')).toBeTruthy()
    await waitFor(() => expectPlanShownOnce())
    expectPlanAboveReader('Comic book reader: 1 of 10 pages ready.')
  })

  it.each(['stop', 'failure'] as const)('settles early pages before a new turn after %s', async (ending) => {
    const { boundary, pages } = installComicBoundary()
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })
    await send(COMIC_REQUEST, user)
    await waitFor(() => expect(boundary.calls).toHaveLength(1))
    await act(async () => {
      for (const request of PAGE_REQUESTS) {
        boundary.emitStream({
          streamId: boundary.calls[0]!.streamId,
          type: 'image_request',
          request
        })
      }
    })
    await waitFor(() => expect(pages).toHaveLength(1))
    if (ending === 'stop') {
      await user.click(screen.getByRole('button', { name: STOP }))
    } else {
      await act(async () => boundary.reject(0, new Error('Remote chat disconnected.')))
    }
    await waitFor(() => expect(screen.queryByRole('button', { name: STOP })).toBeNull())
    await send('Start a new text turn', user)
    await waitFor(() => expect(boundary.calls).toHaveLength(2))
    await act(async () => boundary.resolve(1, 'A fresh reply.'))
    expect(await screen.findByText('A fresh reply.')).toBeTruthy()
    expect(pages).toHaveLength(1)
  })

  it('keeps the plan and the reader visible when a page fails, and reports the failure', async () => {
    const { boundary, pages } = installComicBoundary()
    const user = userEvent.setup()
    renderChat({ conversationId: 'conversation-a' })

    await startComicRun(boundary, pages, user)
    await act(async () => pages[1]!.reject(new Error('The image server ran out of memory.')))
    await waitFor(() => expect(pages).toHaveLength(3))

    expect(await screen.findByText(/Page 2: The image server ran out of memory\./)).toBeTruthy()
    expect(screen.getByText('Comic book reader: 1 of 10 pages ready.')).toBeTruthy()
    expectPlanShownOnce()
    expectPlanAboveReader('Comic book reader: 1 of 10 pages ready.')
  })

  it('shows the plan once when Chat remounts while page 2 is still generating', async () => {
    const { boundary, pages } = installComicBoundary()
    const user = userEvent.setup()
    const view = renderChat({ conversationId: 'conversation-a' })

    await startComicRun(boundary, pages, user)
    expect(await screen.findByText('Comic book reader: 1 of 10 pages ready.')).toBeTruthy()

    // Main keeps the text stream open into the image phase, still holding the answer it streamed.
    boundary.activeRagStreams.push({
      streamId: boundary.calls[0]!.streamId,
      conversationId: 'conversation-a',
      messageId: 'pending-image-row',
      content: PLAN,
      reasoning: '',
      reasoningRequested: false,
      phase: 'loading_image_model',
      tools: PAGE_REQUESTS.map(() => ({ name: 'generate_image', status: 'completed' as const }))
    })
    view.unmount()
    renderChat({ conversationId: 'conversation-a' })

    expect(await screen.findByText('Comic book reader: 1 of 10 pages ready.')).toBeTruthy()
    await waitFor(() => expectPlanShownOnce())
  })

  it('shows the plan once after every page completes and after a reload', async () => {
    const { boundary, pages } = installComicBoundary()
    const user = userEvent.setup()
    const view = renderChat({ conversationId: 'conversation-a' })

    await startComicRun(boundary, pages, user)
    await act(async () => pages[1]!.resolve(2))
    await waitFor(() => expect(pages).toHaveLength(3))
    await act(async () => pages[2]!.resolve(3))

    expect(await screen.findByText('Comic book reader: 3 of 10 pages ready.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('button', { name: STOP })).toBeNull())
    expectPlanShownOnce()
    expectPlanAboveReader('Comic book reader: 3 of 10 pages ready.')

    view.unmount()
    renderChat({ conversationId: 'conversation-a' })
    expect(await screen.findByText('Comic book reader: 3 of 10 pages ready.')).toBeTruthy()
    expectPlanShownOnce()
  })

  it('shows the plan once after Stop during page 2', async () => {
    const { boundary, pages } = installComicBoundary()
    const user = userEvent.setup()
    const view = renderChat({ conversationId: 'conversation-a' })

    await startComicRun(boundary, pages, user)
    await user.click(await screen.findByRole('button', { name: STOP }))

    await waitFor(() => expect(screen.queryByRole('button', { name: STOP })).toBeNull())
    expect(await screen.findByText('Comic book reader: 1 of 10 pages ready.')).toBeTruthy()
    expectPlanShownOnce()
    expectPlanAboveReader('Comic book reader: 1 of 10 pages ready.')

    view.unmount()
    renderChat({ conversationId: 'conversation-a' })
    expect(await screen.findByText('Comic book reader: 1 of 10 pages ready.')).toBeTruthy()
    expectPlanShownOnce()
  })
})
