// A container can report every host core while its CPU quota allows far fewer (a RunPod pod: 128
// cores seen, 13.6 allowed). Thread counts taken from the seen cores oversubscribe the quota and
// the kernel throttles every thread, so inference slows to a crawl. Pure: the caller reads the files.

/**
 * The cores the quota allows, from cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>") or
 * cgroup v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us` (quota -1 = no limit). Null when unlimited
 * or unreadable.
 */
export function cgroupCpuQuota(
  cpuMax: string | null,
  cfsQuotaUs: string | null = null,
  cfsPeriodUs: string | null = null
): number | null {
  const [quota, period] = cpuMax?.trim().split(/\s+/) ?? [cfsQuotaUs?.trim(), cfsPeriodUs?.trim()]
  const q = Number(quota)
  const p = Number(period)
  if (!quota || quota === 'max' || !Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0)
    return null
  return q / p
}

/** Whole cores to plan threads with: the logical count, capped by the quota (never below 1). */
export function usableCores(logical: number, quota: number | null): number {
  return Math.max(1, quota === null ? logical : Math.min(logical, Math.floor(quota)))
}
