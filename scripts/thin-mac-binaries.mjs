import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { packagedResourcesDir, targetOnnxRuntime } from './prune-onnx-runtime.mjs'

// The engines in resources/bin are universal (arm64 + x86_64) so one checkout serves every
// Mac. A Mac release is one architecture, so the other slice is dead weight in the update
// zip. This runs from afterPack, which electron-builder calls BEFORE it signs the app, so
// every thinned file is signed in its final form.
const LIPO_ARCH = new Map([
  ['arm64', 'arm64'],
  ['x64', 'x86_64']
])
const FAT_MAGIC = new Set([0xcafebabe, 0xcafebabf])

function isFatMachO(file) {
  const descriptor = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(8)
    if (fs.readSync(descriptor, header, 0, 8, 0) < 8) return false
    // Java class files share 0xCAFEBABE; a fat header's second word is a small slice count.
    return FAT_MAGIC.has(header.readUInt32BE(0)) && header.readUInt32BE(4) < 16
  } finally {
    fs.closeSync(descriptor)
  }
}

function regularFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(entryPath)
      else if (entry.isFile()) files.push(entryPath)
    }
  }
  return files
}

/** Thin every universal Mach-O file under the packaged Resources folder to the target arch. */
export function thinMacUniversalBinaries(context) {
  if (context.electronPlatformName !== 'darwin') return []
  const lipoArch = LIPO_ARCH.get(targetOnnxRuntime(context).arch)
  if (!lipoArch) return [] // A universal build keeps both slices.
  const resources = packagedResourcesDir(context)
  const thinned = []
  for (const file of regularFiles(resources)) {
    if (!isFatMachO(file)) continue
    const archs = String(execFileSync('lipo', ['-archs', file], { encoding: 'utf8' }))
      .trim()
      .split(/\s+/)
    if (!archs.includes(lipoArch)) {
      throw new Error(
        `${path.relative(resources, file)} has no ${lipoArch} slice (${archs.join(', ')})`
      )
    }
    const output = `${file}.thin`
    execFileSync('lipo', [file, '-thin', lipoArch, '-output', output])
    fs.chmodSync(output, fs.statSync(file).mode)
    fs.renameSync(output, file)
    thinned.push(path.relative(resources, file))
  }
  console.log(`[thin-mac-binaries] thinned ${thinned.length} universal files to ${lipoArch}`)
  return thinned
}
