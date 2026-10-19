import { execFileSync } from 'child_process'

/**
 * Free and total VRAM of the emptiest NVIDIA GPU, in MB, or null when nvidia-smi is missing or fails. Read
 * once per team-mode launch on a CUDA machine to size llama-server's slots; never on a request.
 */
export function cudaVramMB(): { freeMB: number; totalMB: number } | null {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 2_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const cards = out
      .split(/\r?\n/)
      .map((line) => line.split(',').map((part) => Number(part.trim())))
      .filter(([free, total]) => Number.isFinite(free) && Number.isFinite(total) && total! > 0)
      .map(([free, total]) => ({ freeMB: free!, totalMB: total! }))
    return cards.length ? cards.reduce((a, b) => (b.freeMB > a.freeMB ? b : a)) : null
  } catch {
    return null
  }
}
