import path from 'node:path'

/** GPU VM deployments opt in; CPU-only desktops keep the normal engine ladder. */
export function cudaRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OFFGRID_REQUIRE_CUDA === '1'
}

export function permitsEngine(
  serverPath: string,
  layers: number,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!cudaRequired(env)) return true
  const directory = path.posix.basename(path.posix.dirname(serverPath.replaceAll('\\', '/')))
  return directory.endsWith('-cuda') && layers !== 0
}

export function permitsOffload(
  serverPath: string,
  layers: number,
  confirmed: number | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    !cudaRequired(env) ||
    (permitsEngine(serverPath, layers, env) && confirmed !== null && confirmed > 0)
  )
}
