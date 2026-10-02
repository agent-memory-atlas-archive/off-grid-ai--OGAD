import { describe, expect, it } from 'vitest'
import {
  modelRuntimeBackend,
  runtimeBackendLabel,
  type RuntimeBackend
} from '../runtime-backends'

describe('runtime backend display', () => {
  it('shows a useful status before and after the engine reports placement', () => {
    const value: RuntimeBackend = { id: 'chat', state: 'loading' }
    expect(runtimeBackendLabel()).toBe('Not loaded')
    expect(runtimeBackendLabel(value)).toBe('Loading model…')
    expect(runtimeBackendLabel({ ...value, state: 'loaded' })).toBe('Backend not confirmed')
    expect(runtimeBackendLabel({ ...value, state: 'loaded', backend: 'Metal', device: 'GPU' })).toBe(
      'Metal · GPU'
    )
    expect(runtimeBackendLabel({ ...value, state: 'error' })).toBe('Engine stopped')
    expect(runtimeBackendLabel({ ...value, state: 'stopped' })).toBe('Not loaded')
    expect(runtimeBackendLabel({ ...value, state: 'unavailable' })).toBe('Status unavailable')
  })

  it('does not borrow a different model’s backend when the selected model is unavailable', () => {
    const values: RuntimeBackend[] = [
      { id: 'chat', model: 'other.gguf', state: 'loaded', backend: 'CUDA' },
      { id: 'chat', state: 'unavailable' },
      { id: 'image', model: 'selected.gguf', state: 'loaded', backend: 'CPU' }
    ]
    expect(modelRuntimeBackend(values, 'chat', ['selected.gguf'])).toEqual(values[1])
    values.unshift({ id: 'chat', model: '/models/selected.gguf', state: 'loaded', backend: 'Metal' })
    expect(modelRuntimeBackend(values, 'chat', ['selected.gguf'])).toEqual(values[0])
    expect(modelRuntimeBackend(values, 'chat', ['/models/selected.gguf'])).toEqual(values[0])
  })
})
