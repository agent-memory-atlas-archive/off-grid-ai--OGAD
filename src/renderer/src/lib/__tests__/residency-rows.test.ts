import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  RESIDENCY_ROWS,
  lockedResidencyRows,
  residencyStatusText,
  residencySwitchLabel,
  unlockedResidencyRows
} from '../residency-rows'

describe('residency rows', () => {
  it('covers every modality the residency store persists, exactly once', () => {
    expect(RESIDENCY_ROWS.map((r) => r.modality)).toEqual([
      'llm',
      'image',
      'stt',
      'tts',
      'grounding',
      'decision',
      'embeddings'
    ])
  })

  it('keeps chat/capture the only locked row', () => {
    expect(lockedResidencyRows().map((r) => r.modality)).toEqual(['llm'])
    expect(unlockedResidencyRows().map((r) => r.modality)).toEqual([
      'image',
      'stt',
      'tts',
      'grounding',
      'decision',
      'embeddings'
    ])
  })

  it('gives every row a non-empty label and hint', () => {
    for (const row of RESIDENCY_ROWS) {
      expect(row.label.length).toBeGreaterThan(0)
      expect(row.hint.length).toBeGreaterThan(0)
    }
  })

  it('derives switch names as "<label> residency"', () => {
    expect(residencySwitchLabel({ label: 'Image generation' })).toBe('Image generation residency')
    expect(residencySwitchLabel({ label: 'Chat and capture model' })).toBe(
      'Chat and capture model residency'
    )
  })

  it('produces a unique switch name per row (so selectors cannot collide)', () => {
    const names = RESIDENCY_ROWS.map(residencySwitchLabel)
    expect(new Set(names).size).toBe(names.length)
  })

  it('marks locked rows as required regardless of resident state', () => {
    expect(residencyStatusText({ locked: true }, true)).toBe('in-memory (required)')
    expect(residencyStatusText({ locked: true }, false)).toBe('in-memory (required)')
  })

  it('reports in-memory vs on-demand for unlocked rows', () => {
    expect(residencyStatusText({}, true)).toBe('in-memory')
    expect(residencyStatusText({}, false)).toBe('on-demand')
  })
})

describe('residency rows are the single source of truth', () => {
  // Guard the extraction itself: if someone re-inlines the rows or the aria-label template
  // into the component, the E2E suite's derived selectors silently stop matching the UI.
  // That exact drift is why settings-residency.spec.ts was failing unnoticed.
  const component = fs.readFileSync(
    path.join(__dirname, '..', '..', 'components', 'ProcessingControls.tsx'),
    'utf8'
  )

  it('has the component import the shared rows rather than declaring its own', () => {
    expect(component).toContain("from '@renderer/lib/residency-rows'")
    expect(component).not.toMatch(/const RESIDENCY_ROWS\s*[:=]/)
  })

  it('has the component derive the switch name from the shared helper', () => {
    expect(component).toContain('aria-label={residencySwitchLabel(row)}')
    expect(component).not.toMatch(/aria-label=\{`\$\{row\.label\} residency`\}/)
  })
})
