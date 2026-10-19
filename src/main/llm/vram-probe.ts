import { execFileSync } from 'child_process'

/**
 * Free VRAM on the emptiest NVIDIA GPU, in MB, or null when nvidia-smi is missing or fails. Read
 * once per team-mode launch on a CUDA machine to size llama-server's slots; never on a request.
 */
export function cudaFreeVramMB(): number | null {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
      { timeout: 2_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const values = out
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value) && value > 0)
    return values.length ? Math.max(...values) : null
  } catch {
    return null
  }
}
