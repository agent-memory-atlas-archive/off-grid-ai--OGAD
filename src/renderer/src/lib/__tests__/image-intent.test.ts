import { describe, it, expect } from 'vitest'
import { cleanImagePrompt } from '../image-intent'

describe('cleanImagePrompt', () => {
  it('strips the leading generate-verb phrasing to leave the subject', () => {
    expect(cleanImagePrompt('draw a dog')).toBe('a dog')
    expect(cleanImagePrompt('generate an image of a fox in a forest')).toBe('a fox in a forest')
    expect(cleanImagePrompt('create a picture of a beach')).toBe('a beach')
    expect(cleanImagePrompt('paint a sunset')).toBe('a sunset')
  })

  it('falls back to the original when stripping would empty it', () => {
    expect(cleanImagePrompt('a lone red fox, cinematic')).toBe('a lone red fox, cinematic')
  })
})
