import fs from 'node:fs'
import os from 'node:os'
import { cgroupCpuQuota, usableCores } from '../shared/cpu-quota'

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

let quota: number | null | undefined

/** The container's CPU quota in cores (Linux cgroups), or null when there is none. */
export function cpuQuota(): number | null {
  if (quota !== undefined) return quota
  quota =
    process.platform === 'linux'
      ? cgroupCpuQuota(
          read('/sys/fs/cgroup/cpu.max'),
          read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
          read('/sys/fs/cgroup/cpu/cpu.cfs_period_us')
        )
      : null
  return quota
}

/** Logical cores this process may actually use: what the OS reports, capped by a CPU quota. */
export function usableCpuCount(): number {
  return usableCores(os.availableParallelism(), cpuQuota())
}
