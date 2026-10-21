import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import afterPack from '../../../scripts/after-pack.mjs'
import { packagedResourcesDir } from '../../../scripts/prune-onnx-runtime.mjs'
import { thinMacUniversalBinaries } from '../../../scripts/thin-mac-binaries.mjs'

// electron-builder's afterPack hook, run on a packaged tree in a temp folder. Every file here is
// a plain file, so no step needs lipo: these run on the Linux CI runner too.
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

interface PackContext {
  appOutDir: string
  electronPlatformName: string
  arch: number
  packager: { appInfo: { productFilename: string } }
}

function packContext(electronPlatformName: string, arch: number): PackContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-after-pack-'))
  roots.push(root)
  return {
    appOutDir: root,
    electronPlatformName,
    arch,
    packager: { appInfo: { productFilename: 'Off Grid AI Desktop' } }
  }
}

/** The ONNX Runtime folders electron-builder copies for every platform and architecture. */
function onnxRuntimes(context: PackContext, targets: string[]): string {
  const runtimeRoot = path.join(
    packagedResourcesDir(context),
    'app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6'
  )
  for (const target of targets) {
    fs.mkdirSync(path.join(runtimeRoot, target), { recursive: true })
    fs.writeFileSync(path.join(runtimeRoot, target, 'runtime.bin'), target)
  }
  return runtimeRoot
}

/** A file that starts with a universal Mach-O header: the fat magic and a slice count. */
function fatHeader(file: string): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(0xcafebabe, 0)
  header.writeUInt32BE(2, 4)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, header)
  return header
}

describe('packaged app afterPack', () => {
  it('prunes a Mac app to its ONNX Runtime and leaves files that are not Mach-O alone', async () => {
    const context = packContext('darwin', 3)
    const runtimeRoot = onnxRuntimes(context, ['darwin/arm64', 'darwin/x64', 'linux/x64'])
    const resources = packagedResourcesDir(context)
    // A Java class file shares the fat magic; its second word is a class version, not a count.
    const classFile = path.join(resources, 'bin', 'Example.class')
    fs.mkdirSync(path.dirname(classFile), { recursive: true })
    fs.writeFileSync(classFile, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]))
    const tiny = path.join(resources, 'bin', 'version.txt')
    fs.writeFileSync(tiny, '1\n')

    await afterPack(context)

    expect(fs.existsSync(path.join(runtimeRoot, 'darwin/arm64/runtime.bin'))).toBe(true)
    expect(fs.existsSync(path.join(runtimeRoot, 'darwin/x64'))).toBe(false)
    expect(fs.existsSync(path.join(runtimeRoot, 'linux'))).toBe(false)
    expect(fs.readFileSync(classFile)).toHaveLength(8)
    expect(fs.readFileSync(tiny, 'utf8')).toBe('1\n')
  })

  it('prunes a Linux app and never thins its files', async () => {
    const context = packContext('linux', 1)
    const runtimeRoot = onnxRuntimes(context, ['linux/x64', 'linux/arm64', 'win32/x64'])
    const universal = path.join(packagedResourcesDir(context), 'bin', 'engine')
    const header = fatHeader(universal)

    await afterPack(context)

    expect(fs.existsSync(path.join(runtimeRoot, 'linux/x64/runtime.bin'))).toBe(true)
    expect(fs.existsSync(path.join(runtimeRoot, 'linux/arm64'))).toBe(false)
    expect(fs.existsSync(path.join(runtimeRoot, 'win32'))).toBe(false)
    expect(fs.readFileSync(universal)).toEqual(header)
  })

  it('fails the build when the packaged ONNX Runtime is missing', async () => {
    await expect(afterPack(packContext('darwin', 3))).rejects.toThrow(
      /Packaged ONNX Runtime directory is missing/
    )
  })

  it('keeps every slice of a universal Mac build', () => {
    const context = packContext('darwin', 4)
    const universal = path.join(packagedResourcesDir(context), 'bin', 'engine')
    const header = fatHeader(universal)

    expect(thinMacUniversalBinaries(context)).toEqual([])
    expect(fs.readFileSync(universal)).toEqual(header)
  })
})
