import { expect, it } from 'vitest'
import { enginePriority } from '../engine-priority'
it('tries CUDA and Metal/Vulkan across roots before CPU', () => {
  const paths = ['/a/llama-cpu/server', '/b/llama/server', 'C:\\b\\llama-cuda\\server.exe']
  expect(paths.sort((a, b) => enginePriority(a) - enginePriority(b))).toEqual([
    'C:\\b\\llama-cuda\\server.exe',
    '/b/llama/server',
    '/a/llama-cpu/server'
  ])
  expect(enginePriority('/a/llama-prism-cpu/server')).toBe(2)
})
