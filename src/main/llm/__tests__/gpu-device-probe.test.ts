import { describe, expect, it } from 'vitest'
import {
  hasGpuDevice,
  listedGpuMemoryMB,
  offloadedGpuLayers,
  offloadedLayerShare
} from '../gpu-device-probe'

describe('hasGpuDevice', () => {
  it('accepts an enumerated Vulkan GPU', () => {
    expect(hasGpuDevice('Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4060', 'Vulkan')).toBe(true)
    expect(hasGpuDevice('Available devices:\n  Vulkan1: AMD Radeon', 'Vulkan')).toBe(true)
  })

  it('accepts CUDA only when a CUDA device is listed', () => {
    expect(hasGpuDevice('Available devices:\n  CUDA0: NVIDIA GeForce RTX 4060', 'CUDA')).toBe(true)
    expect(hasGpuDevice('Available devices:\n  Vulkan0: NVIDIA GeForce RTX 4060', 'CUDA')).toBe(false)
  })

  it('rejects a binary that can only run on the CPU', () => {
    expect(hasGpuDevice('Available devices:\n  (none)', 'Vulkan')).toBe(false)
    expect(hasGpuDevice('Available devices:\n  CPU0: x86_64', 'CUDA')).toBe(false)
    expect(hasGpuDevice('failed to list devices', 'CUDA')).toBe(false)
    expect(hasGpuDevice('Available devices:\n  Vulkan0: llvmpipe (LLVM 15.0.7)', 'Vulkan')).toBe(false)
    expect(hasGpuDevice('Available devices:\n  Vulkan0: Microsoft Basic Render Driver', 'Vulkan')).toBe(false)
  })
})

describe('offloadedGpuLayers', () => {
  it('reads the engine confirmation after a model load', () => {
    expect(offloadedGpuLayers('llama_model_load_tensors: offloaded 25/25 layers to GPU')).toBe(25)
    expect(offloadedGpuLayers('offloaded 0/25 layers to GPU')).toBe(0)
  })

  it('does not infer offload from a device list or requested layer count', () => {
    expect(offloadedGpuLayers('Available devices:\n  CUDA0: NVIDIA RTX 4060')).toBeNull()
    expect(offloadedGpuLayers('n_gpu_layers = 99')).toBeNull()
  })
})

describe('listedGpuMemoryMB', () => {
  it('reads the largest card of the backend from llama.cpp\'s device list', () => {
    const listing =
      'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3060 (Rev 1) (12288 MiB, 11800 MiB free)\n  Vulkan1: Intel UHD (4096 MiB, 4000 MiB free)'
    expect(listedGpuMemoryMB(listing, 'Vulkan')).toBe(12288)
    expect(listedGpuMemoryMB(listing, 'CUDA')).toBeNull()
    expect(listedGpuMemoryMB('failed to list devices', 'Vulkan')).toBeNull()
  })
})

describe('offloadedLayerShare', () => {
  it('reads the placed and total layers from the last load', () => {
    expect(offloadedLayerShare('load_tensors: offloaded 31/49 layers to GPU')).toEqual({
      layers: 31,
      total: 49
    })
    expect(offloadedLayerShare('Available devices:')).toBeNull()
  })
})
