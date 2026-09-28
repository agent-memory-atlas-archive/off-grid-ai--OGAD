import { describe, expect, it } from 'vitest'
import { permitsEngine, permitsOffload } from '../gpu-policy'

const required = { OFFGRID_REQUIRE_CUDA: '1' }
const cuda = 'C:\\app\\llama-cuda\\llama-server.exe'
describe('required CUDA', () => {
  it('rejects CPU and Vulkan executables even with GPU layers requested', () => {
    for (const dir of ['llama-cpu', 'llama', 'llama-prism-cpu']) {
      expect(permitsEngine(`C:\\app\\${dir}\\llama-server.exe`, 99, required)).toBe(false)
    }
    expect(permitsEngine(cuda, 99, required)).toBe(true)
    expect(permitsEngine('/app/llama-prism-cuda/llama-server', -1, required)).toBe(true)
  })
  it('rejects CPU-only OOM retry and unconfirmed or zero offload', () => {
    expect(permitsEngine(cuda, 0, required)).toBe(false)
    for (const count of [null, 0]) expect(permitsOffload(cuda, 99, count, required)).toBe(false)
    expect(permitsOffload(cuda, 99, 33, required)).toBe(true)
  })
  it('preserves normal fallback when not enabled', () => {
    expect(permitsEngine('/app/llama-cpu/llama-server', 0, {})).toBe(true)
    expect(permitsOffload(cuda, 0, null, {})).toBe(true)
  })
})
