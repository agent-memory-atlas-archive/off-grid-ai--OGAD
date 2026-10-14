/**
 * The engine updater against a real HTTP store and a real data folder. Only the store is local:
 * it serves a signed index and content-addressed files exactly as the runtime store does.
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEngineUpdater, type EngineUpdater } from '../engine-updates'
import type { EngineRelease } from '../../shared/engine-updates'

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')

let server: http.Server
let base: string
let routes: Map<string, Buffer>
let requested: string[]
let dataDir: string
let packBin: string
let enabled: boolean
let stalledFile: 'headers' | 'body' | null

const RUNTIME = Buffer.from('cuda runtime library bytes')

function engineScript(version: string, exitCode = 0): Buffer {
  return Buffer.from(`#!/bin/sh\necho "version: ${version}"\nexit ${exitCode}\n`)
}

function publish(
  releases: { version: string; server: Buffer }[],
  signWith = keys.privateKey
): void {
  routes = new Map()
  const engines: EngineRelease[] = releases.map(({ version, server: body }) => {
    routes.set(`/files/${sha(body)}`, body)
    routes.set(`/files/${sha(RUNTIME)}`, RUNTIME)
    return {
      id: 'llama-cuda',
      version,
      smokeTest: 'llama-cuda/llama-server',
      files: [
        { path: 'llama-cuda/llama-server', sha256: sha(body), size: body.length, mode: 0o755 },
        { path: 'cuda-runtime/libcudart.so.12', sha256: sha(RUNTIME), size: RUNTIME.length }
      ],
      links: [{ path: 'llama-cuda/libllama.so', target: 'llama-server' }]
    }
  })
  const index = Buffer.from(JSON.stringify({ schemaVersion: 1, platform: 'linux', engines }))
  routes.set('/index.json', index)
  routes.set('/index.json.sig', Buffer.from(sign(null, index, signWith).toString('base64')))
}

function updater(fileIdleTimeoutMs?: number): EngineUpdater {
  return createEngineUpdater({
    platform: 'linux',
    dataDir: () => dataDir,
    appVersion: () => '0.0.56',
    enabled: () => enabled,
    setEnabled: (value) => {
      enabled = value
    },
    hasGpu: () => true,
    packBin: () => packBin || null,
    indexUrl: () => `${base}/index.json`,
    fileUrl: (hash) => `${base}/files/${hash}`,
    publicKey,
    fileIdleTimeoutMs
  })
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-updates-'))
  packBin = path.join(dataDir, 'pack', 'bin')
  fs.mkdirSync(path.join(packBin, 'cuda-runtime'), { recursive: true })
  fs.writeFileSync(path.join(packBin, 'cuda-runtime', 'libcudart.so.12'), RUNTIME)
  enabled = true
  stalledFile = null
  requested = []
  routes = new Map()
  server = http.createServer((req, res) => {
    requested.push(req.url ?? '')
    const body = routes.get(req.url ?? '')
    if (!body) {
      res.writeHead(404).end()
      return
    }
    if (stalledFile && req.url?.startsWith('/files/')) {
      if (stalledFile === 'body') {
        res.writeHead(200, { 'content-length': body.length })
        res.write(body.subarray(0, 1))
      }
      return
    }
    res.writeHead(200, { 'content-length': body.length }).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterEach(async () => {
  delete process.env.OFFGRID_ENGINE_ROOTS
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('engine updates', () => {
  it('makes no network request when the CUDA pack was not installed', async () => {
    packBin = ''
    publish([{ version: 'b11551', server: engineScript('b11551') }])
    expect((await updater().check()).installed).toEqual({})
    expect(requested).toEqual([])
  })

  it.each(['headers', 'body'] as const)('recovers after a file stalls at %s', async (stage) => {
    publish([{ version: 'b11551', server: engineScript('b11551') }])
    stalledFile = stage
    const engines = updater(150)
    expect((await engines.check()).phase).toBe('failed')
    expect(fs.readdirSync(path.join(dataDir, 'engines', 'files'))).toEqual([])
    stalledFile = null
    expect((await engines.check()).installed).toEqual({ 'llama-cuda': 'b11551' })
  })

  it('installs a signed engine, reuses the pack’s identical files, and searches it first', async () => {
    publish([{ version: 'b11551', server: engineScript('b11551') }])
    const engines = updater()
    const status = await engines.check()

    expect(status.phase).toBe('up-to-date')
    expect(status.installed).toEqual({ 'llama-cuda': 'b11551' })
    const [folder] = engines.activeRoots()
    expect(folder).toBe(path.join(dataDir, 'engines', 'linux-llama-cuda-b11551'))
    expect(process.env.OFFGRID_ENGINE_ROOTS).toBe(folder)
    expect(fs.readFileSync(path.join(folder!, 'cuda-runtime', 'libcudart.so.12'))).toEqual(RUNTIME)
    expect(fs.readlinkSync(path.join(folder!, 'llama-cuda', 'libllama.so'))).toBe('llama-server')
    expect(fs.statSync(path.join(folder!, 'llama-cuda', 'llama-server')).mode & 0o111).not.toBe(0)
    // The runtime library already sat in the pack, so only the engine itself was downloaded.
    expect(requested.filter((url) => url.startsWith('/files/'))).toEqual([
      `/files/${sha(engineScript('b11551'))}`
    ])
  })

  it('refuses an index signed by another key and installs nothing', async () => {
    publish(
      [{ version: 'b11551', server: engineScript('b11551') }],
      generateKeyPairSync('ed25519').privateKey
    )
    const engines = updater()
    const status = await engines.check()

    expect(status.phase).toBe('failed')
    expect(status.error).toMatch(/signature/)
    expect(engines.activeRoots()).toEqual([])
    expect(requested.some((url) => url.startsWith('/files/'))).toBe(false)
  })

  it('reports up to date without an error when the store publishes no index for the platform', async () => {
    const engines = updater()
    const status = await engines.check()

    expect(status.phase).toBe('up-to-date')
    expect(status.error).toBeUndefined()
    expect(status.installed).toEqual({})
    expect(requested.some((url) => url.startsWith('/files/'))).toBe(false)
  })

  it('keeps the current engine when the new one does not start', async () => {
    publish([{ version: 'b11551', server: engineScript('b11551') }])
    const engines = updater()
    await engines.check()
    publish([{ version: 'b11600', server: engineScript('b11600', 1) }])
    const status = await engines.check()

    expect(status.phase).toBe('failed')
    expect(status.error).toMatch(/did not start/)
    expect(status.installed).toEqual({ 'llama-cuda': 'b11551' })
    expect(engines.activeRoots()).toEqual([
      path.join(dataDir, 'engines', 'linux-llama-cuda-b11551')
    ])
    expect(
      fs.readdirSync(path.join(dataDir, 'engines')).some((name) => name.startsWith('.staging'))
    ).toBe(false)
  })

  it('keeps the previous release for rollback and removes older ones', async () => {
    const engines = updater()
    for (const version of ['b11551', 'b11600', 'b11700']) {
      publish([{ version, server: engineScript(version) }])
      await engines.check()
    }
    const folders = fs
      .readdirSync(path.join(dataDir, 'engines'))
      .filter((name) => name.startsWith('linux-'))
    expect(folders.sort()).toEqual(['linux-llama-cuda-b11600', 'linux-llama-cuda-b11700'])
    expect(engines.status().installed).toEqual({ 'llama-cuda': 'b11700' })
  })

  it('downloads only what changed when a new release keeps most files', async () => {
    const engines = updater()
    publish([{ version: 'b11551', server: engineScript('b11551') }])
    await engines.check()
    fs.rmSync(path.join(packBin, 'cuda-runtime'), { recursive: true })
    requested = []
    publish([{ version: 'b11600', server: engineScript('b11600') }])
    await engines.check()

    expect(requested.filter((url) => url.startsWith('/files/'))).toEqual([
      `/files/${sha(engineScript('b11600'))}`
    ])
    expect(fs.existsSync(path.join(dataDir, 'engines', 'files'))).toBe(false)
  })

  it('does not contact the store while the setting is off, and checks when it is turned on', async () => {
    enabled = false
    publish([{ version: 'b11551', server: engineScript('b11551') }])
    const engines = updater()

    expect((await engines.check()).phase).toBe('disabled')
    expect(requested).toEqual([])
    const status = await engines.setEnabled(true)
    expect(status.installed).toEqual({ 'llama-cuda': 'b11551' })
  })
})
