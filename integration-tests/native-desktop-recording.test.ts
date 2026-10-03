import { it, expect } from 'vitest'
import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

// This separate CI job owns a virtual desktop and virtual sound devices. Never
// run it against a developer's current screen or microphone.
it.runIf(process.env.OFFGRID_NATIVE_DESKTOP_TEST === '1')(
  'records native video and both audio tracks and pastes into the selected window',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-native-parity-'))
    const output = path.resolve('coverage-native-desktop-raw')
    try {
      await fs.mkdir(path.join(root, 'temp'))
      await fs.mkdir(output, { recursive: true })
      const dependencies = JSON.parse(await fs.readFile('package.json', 'utf8'))
      const external = ['electron', ...Object.keys(dependencies.dependencies)]
      const main = path.join(output, 'main.cjs')
      await build({
        entryPoints: ['pro/main/__tests__/native-desktop.fixture.ts'],
        outfile: main,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        sourcemap: 'inline',
        tsconfig: 'pro/tsconfig.json',
        external,
        loader: { '.py': 'text' },
        define: {
          'import.meta.url': JSON.stringify(pathToFileURL(main).href),
          __OFFGRID_PRO__: 'true'
        },
        plugins: [
          {
            name: 'private-recorder-source',
            setup(builder) {
              builder.onResolve({ filter: /\.py\?raw$/ }, (args) => ({
                path: path.resolve(args.resolveDir, args.path.slice(0, -4))
              }))
            }
          }
        ]
      })
      await fs.mkdir(path.join(output, 'out/preload'), { recursive: true })
      await build({
        entryPoints: ['pro/main/meeting-recorder-preload.ts'],
        outfile: path.join(output, 'out/preload/meeting-recorder.js'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        sourcemap: 'inline'
      })
      await fs.mkdir(path.join(output, 'resources/linux-desktop'), { recursive: true })
      for (const file of ['portal.py', 'recorder.html']) {
        await fs.copyFile(
          'resources/linux-desktop/' + file,
          path.join(output, 'resources/linux-desktop', file)
        )
      }
      const env = {
        ...process.env,
        NODE_V8_COVERAGE: output,
        OFFGRID_DATA_DIR: path.join(root, 'data'),
        OFFGRID_BIN_DIR: path.join(root, 'no-model-binaries'),
        TEMP: path.join(root, 'temp'),
        TMP: path.join(root, 'temp'),
        TMPDIR: path.join(root, 'temp')
      }
      delete env.ELECTRON_RUN_AS_NODE
      const args = process.platform === 'linux' ? ['--no-sandbox'] : []
      const result = await promisify(execFile)(
        require('electron') as string,
        [...args, path.join(output, 'main.cjs'), root],
        { env, timeout: 100_000, maxBuffer: 4 * 1024 * 1024 }
      )
      expect(result.stdout).toContain('NATIVE_DESKTOP_PARITY_PASSED')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  120_000
)
