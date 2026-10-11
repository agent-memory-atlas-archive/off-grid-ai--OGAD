import { describe, expect, it } from 'vitest'
import { buildAssistantContext, readResponseVariants } from '../message-persistence'
import { mapRagMessages } from '../../components/MemoryChat/helper'

describe('saved response versions', () => {
  it('restores earlier answers and the selected version through stored JSON', () => {
    const context = buildAssistantContext(undefined, {
      variants: ['First answer', 'New answer'],
      variantIndex: 0,
      reasoning: 'Reasoning'
    })
    const restored = mapRagMessages([
      {
        id: 1,
        uuid: 'answer',
        role: 'assistant',
        content: 'New answer',
        context: JSON.stringify(context),
        created_at: '2026-10-11T00:00:00.000Z'
      }
    ])
    expect(restored[0]?.variants).toEqual(['First answer', 'New answer'])
    expect(restored[0]?.variantIndex).toBe(0)
    expect(restored[0]?.reasoning).toBe('Reasoning')
  })

  it('ignores malformed or absent version data', () => {
    for (const context of [null, {}, { variants: ['Only answer'] }, { variants: ['Answer', 1] }]) {
      expect(readResponseVariants(context)).toBeUndefined()
    }
  })
})
