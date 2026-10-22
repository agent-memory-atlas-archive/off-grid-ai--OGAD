import { describe, expect, it } from 'vitest'
import { cgroupCpuQuota, usableCores } from '../cpu-quota'

describe('cgroupCpuQuota', () => {
  it('reads a cgroup v2 quota in cores', () => {
    expect(cgroupCpuQuota('1360000 100000\n')).toBe(13.6)
  })

  it('has no quota when cgroup v2 says max', () => {
    expect(cgroupCpuQuota('max 100000\n')).toBeNull()
  })

  it('falls back to cgroup v1 quota and period', () => {
    expect(cgroupCpuQuota(null, '400000\n', '100000\n')).toBe(4)
  })

  it('has no quota when cgroup v1 quota is -1 or nothing is readable', () => {
    expect(cgroupCpuQuota(null, '-1\n', '100000\n')).toBeNull()
    expect(cgroupCpuQuota(null)).toBeNull()
  })
})

describe('usableCores', () => {
  it('caps the reported cores at the quota', () => {
    expect(usableCores(128, 13.6)).toBe(13)
  })

  it('keeps the reported cores without a quota or under a larger one', () => {
    expect(usableCores(16, null)).toBe(16)
    expect(usableCores(16, 64)).toBe(16)
  })

  it('never plans fewer than one core', () => {
    expect(usableCores(8, 0.5)).toBe(1)
  })
})
