#!/usr/bin/env node
// Start the development app with the CUDA libraries installed by Linux setup.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }

if (process.platform === 'linux' && existsSync('/proc/driver/nvidia/version')) {
  const python = resolve(root, '../build-python/bin/python')
  if (!existsSync(python)) {
    console.error('Linux GPU setup is incomplete. Run scripts/Setup-OGAD-Source.sh first.')
    process.exit(1)
  }

  const site = spawnSync(python, ['-c', 'import site; print(site.getsitepackages()[0])'], {
    encoding: 'utf8'
  })
  if (site.status !== 0) {
    console.error('Cannot find the Linux Python packages. Run scripts/Setup-OGAD-Source.sh first.')
    process.exit(1)
  }

  const cuda = join(site.stdout.trim(), 'nvidia/cu13/lib')
  const cudnn = join(site.stdout.trim(), 'nvidia/cudnn/lib')
  const required = [
    join(cuda, 'libcublas.so.13'),
    join(cuda, 'libcublasLt.so.13'),
    join(cuda, 'libcudart.so.13'),
    join(cuda, 'libcurand.so.10'),
    join(cudnn, 'libcudnn.so.9')
  ]
  const missing = required.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    console.error(`Missing Linux CUDA libraries:\n${missing.join('\n')}`)
    console.error('Run scripts/Setup-OGAD-Source.sh first.')
    process.exit(1)
  }

  env.LD_LIBRARY_PATH = [cuda, cudnn, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  env.OFFGRID_FORCE_CORE ??= '0'
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const child = spawn(npm, ['run', 'dev:inner'], { cwd: root, env, stdio: 'inherit' })
child.on('error', (error) => {
  console.error(`Cannot start the development app: ${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
