/** Search every binary root for GPU engines before accepting a CPU build. */
export function enginePriority(serverPath: string): number {
  const directory = serverPath.replaceAll('\\', '/').split('/').at(-2) ?? ''
  if (directory.endsWith('-cuda')) return 0
  if (directory.endsWith('-cpu')) return 2
  return 1
}
