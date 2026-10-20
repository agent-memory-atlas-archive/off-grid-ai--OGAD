import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { configureRuntime } from '../runtime-env'
import { KEV_4B_ID, desktopCatalog } from '../models-manager'

// The one fake in the Kev runtime tests: the runtime store, as a local HTTP server serving a
// small runtime archive. Everything the app does with it is the real code.

/** A response the store sends instead of the archive: an outage, or a server that mishandles Range. */
export interface KevRuntimeStoreResponse {
  status: number
  headers?: Record<string, string>
  body?: Buffer
}

export interface KevRuntimeStore {
  readonly data: string
  readonly archive: Buffer
  readonly sha256: string
  /** The python3 path the started Kev runtime wrote, once it ran. */
  readonly recordFile: string
  /** Range headers of every archive request, in order. */
  readonly requests: { range?: string }[]
  /** Serve these bytes instead of the archive (a corrupted download). */
  serve(bytes: Buffer): void
  /** Answer every archive request with this response until `reset`. */
  respondWith(response: KevRuntimeStoreResponse): void
  writeManifest(sha256?: string, bytes?: number): void
  /** Fresh profile with Kev 4B's model files on disk and no runtime: an install after updating. */
  reset(): Promise<void>
  close(): Promise<void>
}

/**
 * The runtime store publishes Kev's runtime for Apple silicon Macs only. A Linux or Intel CI
 * runner reports that host for the test, so the same download, verify and install journey runs
 * there: the HTTP server, tar, the filesystem and the started process all stay real.
 * Returns the function that restores the real host.
 */
export function reportAppleSiliconHost(): () => void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
  Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
  return () => {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', arch)
  }
}

function sparseFile(filePath: string, size: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const descriptor = fs.openSync(filePath, 'w')
  fs.ftruncateSync(descriptor, size)
  fs.closeSync(descriptor)
}

async function installKevModelFiles(models: string): Promise<void> {
  const kev = (await desktopCatalog()).find((model) => model.id === KEV_4B_ID)!
  const shards = kev.files
    .map((file) => path.basename(file.name))
    .filter((name) => /^model\.safetensors-\d+-of-\d+\.safetensors$/.test(name))
  for (const file of kev.files) {
    const target = path.join(models, file.name)
    if (path.basename(file.name) !== 'model.safetensors.index.json') {
      sparseFile(target, file.sizeBytes ?? 0)
      continue
    }
    const index = JSON.stringify({
      weight_map: Object.fromEntries(shards.map((shard, i) => [`layer.${i}.weight`, shard]))
    })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, index.padEnd(file.sizeBytes ?? index.length, ' '))
  }
}

/** A runtime whose python3 behaves like the Kev server: it records which Python started,
 *  reports its device, and serves /v1/models on the port it was given. */
function runtimeArchive(root: string): Buffer {
  const source = path.join(root, 'archive-source')
  const python = path.join(source, 'kev-runtime', 'python', 'bin', 'python3')
  fs.mkdirSync(path.dirname(python), { recursive: true })
  fs.writeFileSync(
    python,
    `#!${process.execPath}
const fs = require('node:fs')
const http = require('node:http')
fs.writeFileSync(process.env.KEV_TEST_RECORD, process.argv[1])
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
http.createServer((request, response) => {
  response.writeHead(request.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' })
  response.end('{"data":[]}')
}).listen(port, '127.0.0.1', () => console.error('[Kev] loaded: device=mps'))
`,
    { mode: 0o755 }
  )
  const output = path.join(root, 'kev-runtime.tar.gz')
  execFileSync('tar', ['-czf', output, '-C', source, 'kev-runtime'])
  return fs.readFileSync(output)
}

export async function startKevRuntimeStore(root: string): Promise<KevRuntimeStore> {
  const data = path.join(root, 'data')
  const resources = path.join(root, 'resources')
  const bin = path.join(root, 'bin')
  const recordFile = path.join(root, 'started-python.txt')
  const archive = runtimeArchive(root)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const requests: { range?: string }[] = []
  let served = archive
  let override: KevRuntimeStoreResponse | null = null
  const server = http.createServer((request, response) => {
    const range = request.headers.range
    requests.push({ range })
    if (override) {
      response.writeHead(override.status, override.headers)
      response.end(override.body ?? '')
      return
    }
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
    const body = served.subarray(start)
    response.writeHead(range ? 206 : 200, {
      'content-length': String(body.length),
      ...(range ? { 'content-range': `bytes ${start}-${served.length - 1}/${served.length}` } : {})
    })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const writeManifest = (pin = sha256, bytes = archive.length): void => {
    fs.mkdirSync(resources, { recursive: true })
    fs.writeFileSync(
      path.join(resources, 'kev-runtime-packs.json'),
      JSON.stringify({
        schemaVersion: 1,
        'darwin-arm64': {
          url: `${baseUrl}/desktop/kev-runtime/darwin-arm64/test-v1.tar.gz`,
          sha256: pin,
          bytes,
          version: 'test-v1'
        }
      })
    )
  }

  return {
    data,
    archive,
    sha256,
    recordFile,
    requests,
    serve: (bytes) => {
      served = bytes
    },
    respondWith: (next) => {
      override = next
    },
    writeManifest,
    reset: async () => {
      fs.rmSync(data, { recursive: true, force: true })
      fs.rmSync(recordFile, { force: true })
      requests.length = 0
      served = archive
      override = null
      configureRuntime({ dataDir: data, binRoots: [bin], resourceDirs: [resources] })
      sparseFile(path.join(bin, 'kev-local-server.py'), 1)
      writeManifest()
      await installKevModelFiles(path.join(data, 'models'))
      process.env.KEV_TEST_RECORD = recordFile
    },
    close: async () => {
      delete process.env.KEV_TEST_RECORD
      configureRuntime({ dataDir: undefined, binRoots: undefined, resourceDirs: undefined })
      await new Promise<void>((resolve) => server.close(() => resolve()))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
