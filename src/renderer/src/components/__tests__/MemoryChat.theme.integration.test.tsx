// @vitest-environment jsdom
import { cleanup, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBoundary, installBoundary, renderChat } from './harness/chat-boundary'

describe('<MemoryChat/> theme surfaces', () => {
  beforeEach(() => {
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {}
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
      callback(0)
      return 1
    }
  })

  afterEach(() => {
    cleanup()
    delete document.documentElement.dataset.theme
    vi.unstubAllGlobals()
  })

  it.each(['light', 'dark'] as const)(
    'renders preset cards and the composer from semantic tokens in %s theme',
    async (theme) => {
      document.documentElement.dataset.theme = theme
      const boundary = new ChatBoundary()
      installBoundary(boundary)
      renderChat({ conversationId: 'conversation-a' })

      const composer = await screen.findByTestId('chat-composer')
      const hero = screen.getByTestId('chat-empty-hero')
      const preset = screen.getByTestId('explore-preset-train-my-feed')
      // The composer's surface is the prompt input's group; presets are thin rows inside one
      // list surface (the row's motion wrapper sits between them).
      const composerSurface = within(composer).getAllByRole('group')[0]!
      const presetSurface = preset.parentElement!.parentElement!

      expect(composerSurface.className).toContain('bg-card')
      expect(composerSurface.className).toContain('border-input')
      expect(composerSurface.className).not.toContain('bg-neutral-950')
      expect(composer.getAttribute('data-focus-surface')).toBe('chat-composer')
      expect(composer.parentElement?.className).toBe('w-full')
      expect(hero.className).toContain('bg-card')
      expect(presetSurface.className).toContain('bg-background')
      expect(presetSurface.className).toContain('border-border')
      expect(presetSurface.className).not.toContain('bg-neutral-950')
      expect(preset.className).not.toContain('bg-neutral-950')
    }
  )
})
