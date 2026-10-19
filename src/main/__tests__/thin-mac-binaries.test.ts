import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { thinMacUniversalBinaries } from '../../../scripts/thin-mac-binaries.mjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function macContext(
  root: string,
  arch: number
): {
  appOutDir: string
  electronPlatformName: string
  arch: number
  packager: { appInfo: { productFilename: string } }
} {
  return {
    appOutDir: root,
    electronPlatformName: 'darwin',
    arch,
    packager: { appInfo: { productFilename: 'Off Grid AI Desktop' } }
  }
}

/** A real universal executable, built the way the engines are: one slice per arch, joined by lipo. */
function universalExecutable(directory: string, target: string): void {
  const source = path.join(directory, 'main.c')
  fs.writeFileSync(source, 'int main(void) { return 0; }\n')
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const output = path.join(directory, `main-${arch}`)
    execFileSync('clang', ['-arch', arch, source, '-o', output])
    return output
  })
  fs.mkdirSync(path.dirname(target), { recursive: true })
  execFileSync('lipo', ['-create', ...slices, '-output', target])
  fs.chmodSync(target, 0o755)
}

describe.runIf(process.platform === 'darwin')('packaged macOS engine thinning', () => {
  it('leaves only the arm64 slice in the arm64 app and keeps the file runnable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-thin-'))
    roots.push(root)
    const resources = path.join(root, 'Off Grid AI Desktop.app', 'Contents', 'Resources')
    const engine = path.join(resources, 'bin', 'llama', 'llama-server')
    universalExecutable(root, engine)
    // A Java class file starts with the same magic number and must be left alone.
    const classFile = path.join(resources, 'bin', 'Example.class')
    fs.writeFileSync(classFile, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]))
    const universalSize = fs.statSync(engine).size

    expect(thinMacUniversalBinaries(macContext(root, 3))).toEqual([
      path.join('bin', 'llama', 'llama-server')
    ])

    expect(execFileSync('lipo', ['-archs', engine], { encoding: 'utf8' }).trim()).toBe('arm64')
    expect(fs.statSync(engine).size).toBeLessThan(universalSize)
    expect(fs.statSync(engine).mode & 0o777).toBe(0o755)
    expect(fs.existsSync(`${engine}.thin`)).toBe(false)
    if (process.arch === 'arm64') execFileSync(engine)
    expect(fs.readFileSync(classFile)).toHaveLength(8)
  })

  it('keeps both slices in a universal build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-thin-'))
    roots.push(root)
    const engine = path.join(
      root,
      'Off Grid AI Desktop.app',
      'Contents',
      'Resources',
      'bin',
      'sd',
      'sd-cli'
    )
    universalExecutable(root, engine)

    expect(thinMacUniversalBinaries(macContext(root, 4))).toEqual([])
    expect(execFileSync('lipo', ['-archs', engine], { encoding: 'utf8' }).trim()).toBe(
      'x86_64 arm64'
    )
  })
})
