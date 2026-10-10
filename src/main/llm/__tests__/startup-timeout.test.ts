import { expect, it } from 'vitest'
import { modelStartupQuietLimit, startupStalled } from '../startup-timeout'

it('allows a cold CUDA load to stay quiet for longer than other engines', () => {
  expect(modelStartupQuietLimit('llama-cuda')).toBe(180_000)
  expect(modelStartupQuietLimit('llama-prism-cuda')).toBe(180_000)
  expect(modelStartupQuietLimit('llama')).toBe(60_000)
  expect(modelStartupQuietLimit('llama-cpu')).toBe(60_000)
})

it('keeps waiting on a slow load that still prints progress, however long it takes', () => {
  const start = 0
  // Ten minutes in, but the server wrote a line 5 seconds ago.
  expect(startupStalled(start + 600_000, start + 595_000, 60_000)).toBe(false)
})

it('gives up on a server that has gone silent past the quiet limit', () => {
  expect(startupStalled(61_000, 0, 60_000)).toBe(true)
  expect(startupStalled(60_000, 0, 60_000)).toBe(false)
})
