// Gateway "keep several models loaded": the chosen chat models stay loaded together in one
// llama.cpp router (llama-server --models-preset <ini> --models-max N). A request whose `model` is in
// the set goes to the router; everything else is served as before. The settings come from the shared
// planner (planKeepLoaded); this module only gathers the facts, writes the preset and runs the process.

import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import {
  KEEP_LOADED_CTX_SIZE,
  keepLoadedGpuMemory,
  keepLoadedPresetIni,
  routerModelName,
  planKeepLoaded,
  type KeepLoadedFiles,
  type KeepLoadedMachine,
  type KeepLoadedModel,
  type KeepLoadedPlan
} from '../../shared/keep-loaded-plan'
import type {
  KeepLoadedCandidateContract,
  KeepLoadedModelStatusContract,
  KeepLoadedStateContract
} from '../../shared/ipc-contracts'
import { getSetting, saveSetting } from '../database'
import { llm } from '../llm'
import { readGgufExpertCount, readGgufKvShape } from '../models/gguf-metadata'
import { resolveModelReference } from '../model-paths'
import { binRoots, dataDir, exe } from '../runtime-env'
import { engineSpawnEnv } from '../llm/spawn-env'
import { enginePriority } from '../llm/engine-priority'
import { gpuDeviceAvailable, probedGpuMemoryMB } from '../llm/gpu-device-probe'
import { cudaVramMB } from '../llm/vram-probe'
import { usableCpuCount } from '../cpu-cores'
import { isPortFree, pickFreePort } from '../free-port'
import { UpstreamLimiter } from './upstream-limiter'

const SETTING = 'gatewayKeptModels'
const HOST = '127.0.0.1'
const PREFERRED_PORT = 8460
/** Restarts after an unexpected exit before the router stays down until the next change. */
const MAX_RESTARTS = 3
const RESTART_DELAY_MS = 5_000
const STATUS_TIMEOUT_MS = 2_000

type RouterState = 'off' | 'starting' | 'running' | 'error'

let router: ChildProcess | null = null
let routerPort: number | null = null
let state: RouterState = 'off'
let message: string | undefined
/** The ids the running router serves (the saved set once it started). */
let serving = new Set<string>()
let restarts = 0
let generation = 0
/** The llama-server the router last launched with (null when it has not launched). */
let launchedWith: string | null = null
/** A newer llama.cpp is installed than the router runs; it moves when the person restarts it. */
let engineUpdateReady = false
const limiters = new Map<string, UpstreamLimiter>()

/** The saved set of models to keep loaded. */
export function keptModelIds(): string[] {
  const saved = getSetting<unknown>(SETTING, [])
  return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
}

/** Whether the router serves this model id now. */
export function keepLoadedServes(modelId: string): boolean {
  return state !== 'off' && state !== 'error' && routerPort !== null && serving.has(modelId)
}

export function keepLoadedPort(): number | null {
  return routerPort
}

/** One request at a time per kept model (each runs with one slot); extras wait their turn. */
export function keepLoadedLimiter(modelId: string): UpstreamLimiter {
  let limiter = limiters.get(modelId)
  if (!limiter) {
    limiter = new UpstreamLimiter(modelId, 1)
    limiters.set(modelId, limiter)
  }
  return limiter
}

// ─── Facts for the planner ───────────────────────────────────────────────────

/** The llama-server the router runs: the fastest bundled engine (CUDA, then GPU, then CPU). */
function routerServerPath(): string | null {
  const paths = binRoots()
    .flatMap((root) => [
      path.join(root, 'llama-cuda', exe('llama-server')),
      path.join(root, 'llama', exe('llama-server')),
      path.join(root, 'llama-cpu', exe('llama-server')),
      path.join(root, exe('llama-server'))
    ])
    .filter((p) => fs.existsSync(p))
  return paths.sort((a, b) => enginePriority(a) - enginePriority(b))[0] ?? null
}

async function machineFacts(serverPath: string | null): Promise<KeepLoadedMachine> {
  const totalRamGb = os.totalmem() / 1024 ** 3
  const priority = serverPath ? enginePriority(serverPath) : 2
  let gpuPresent = false
  let gpuMb: number | null = null
  if (process.platform !== 'darwin' && serverPath && priority < 2) {
    const backend = priority === 0 ? 'CUDA' : 'Vulkan'
    gpuPresent = await gpuDeviceAvailable(serverPath, backend, process.platform)
    if (gpuPresent)
      gpuMb =
        probedGpuMemoryMB(serverPath, backend) ??
        (backend === 'CUDA' ? (cudaVramMB()?.totalMB ?? null) : null)
  }
  const memory = keepLoadedGpuMemory({
    platform: process.platform,
    arch: process.arch,
    gpuPresent,
    reportedGpuGb: gpuMb === null ? null : gpuMb / 1024,
    totalRamGb
  })
  // The chat engine keeps its own model loaded beside the router.
  const chatGb = llm.isReady() ? llm.localWeightsGb() : 0
  return {
    ...memory,
    totalRamGb,
    usableCores: usableCpuCount(),
    ...(memory.gpuMemoryGb === null ? { reservedRamGb: chatGb } : { reservedGpuGb: chatGb })
  }
}

const sizeGb = (file: string | null | undefined): number => {
  if (!file) return 0
  try {
    return fs.statSync(file).size / 1024 ** 3
  } catch {
    return 0
  }
}

interface ModelFacts {
  model: KeepLoadedModel
  files: KeepLoadedFiles
}

/** The planner's view of one installed chat model, or null when it is not an installed one. */
async function modelFacts(id: string): Promise<ModelFacts | null> {
  const { resolveChatModelFiles } = await import('../models-manager')
  const resolved = await resolveChatModelFiles(id)
  if ('error' in resolved) return null
  const modelPath = resolveModelReference(resolved.files.primary)
  if (!fs.existsSync(modelPath)) return null
  const mmprojPath = resolved.files.mmproj ? resolveModelReference(resolved.files.mmproj) : null
  const mmproj = mmprojPath && fs.existsSync(mmprojPath) ? mmprojPath : null
  const shape = readGgufKvShape(modelPath, fs)
  return {
    model: {
      id,
      weightsGb: sizeGb(modelPath),
      mmprojGb: sizeGb(mmproj),
      isMoe: readGgufExpertCount(modelPath, fs) > 0,
      layers: shape?.blocks ?? 0,
      kvShape: shape
    },
    files: { model: modelPath, mmproj }
  }
}

async function factsFor(ids: string[]): Promise<ModelFacts[]> {
  const facts = await Promise.all(ids.map((id) => modelFacts(id)))
  return facts.filter((fact): fact is ModelFacts => fact !== null)
}

/** The plan for a set of models on this machine, without applying it. */
export async function planFor(ids: string[]): Promise<KeepLoadedPlan> {
  const facts = await factsFor(ids)
  return planKeepLoaded(
    await machineFacts(routerServerPath()),
    facts.map((fact) => fact.model),
    KEEP_LOADED_CTX_SIZE
  )
}

// ─── The router process ──────────────────────────────────────────────────────

function routerGet(route: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (routerPort === null) return reject(new Error('router not running'))
    const req = http.get(
      { host: HOST, port: routerPort, path: route, timeout: STATUS_TIMEOUT_MS },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('router status timed out')))
    req.on('error', reject)
  })
}

function routerPost(route: string, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (routerPort === null) return reject(new Error('router not running'))
    const body = JSON.stringify(payload)
    const req = http.request(
      {
        host: HOST,
        port: routerPort,
        path: route,
        method: 'POST',
        timeout: STATUS_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve())
      }
    )
    req.on('timeout', () => req.destroy(new Error('router request timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

/** Each kept model's state in the router: loaded, loading, unloaded or failed. */
async function routerModelStatus(): Promise<Map<string, KeepLoadedModelStatusContract['status']>> {
  const out = new Map<string, KeepLoadedModelStatusContract['status']>()
  try {
    const list = (await routerGet('/models')) as {
      data?: { id?: string; status?: { value?: string; failed?: boolean } }[]
    }
    for (const entry of list.data ?? []) {
      if (!entry.id) continue
      const value = entry.status?.value
      out.set(
        entry.id,
        entry.status?.failed
          ? 'failed'
          : value === 'loaded' || value === 'sleeping'
            ? 'loaded'
            : value === 'loading'
              ? 'loading'
              : 'unloaded'
      )
    }
  } catch {
    /* not answering yet */
  }
  return out
}

/** Ask the router to load every kept model it has not started on (load-on-startup covers the
 *  first start; this covers a model the router unloaded or failed to load). */
async function loadMissing(ids: string[]): Promise<void> {
  const status = await routerModelStatus()
  await Promise.all(
    ids
      .map(routerModelName)
      .filter(
        (name) =>
          status.has(name) && status.get(name) !== 'loaded' && status.get(name) !== 'loading'
      )
      .map((name) => routerPost('/models/load', { model: name }).catch(() => {}))
  )
}

function stopRouter(): void {
  generation += 1
  const proc = router
  router = null
  routerPort = null
  serving = new Set()
  if (proc && proc.exitCode === null) proc.kill()
}

/** Wait until the router answers /models, or the process exits. */
async function waitForRouter(proc: ChildProcess, mine: number): Promise<boolean> {
  for (let i = 0; i < 120; i += 1) {
    if (mine !== generation || proc.exitCode !== null) return false
    try {
      await routerGet('/models')
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  return false
}

/** Start (or restart) the router for the saved set. An empty set, or a set that does not fit,
 *  leaves it off and the gateway serves every model as before. */
export async function applyKeepLoaded(): Promise<void> {
  stopRouter()
  const mine = generation
  const ids = keptModelIds()
  message = undefined
  if (!ids.length) {
    state = 'off'
    return
  }
  state = 'starting'
  const serverPath = routerServerPath()
  if (!serverPath) {
    state = 'error'
    message = 'The bundled llama.cpp engine is missing from this build.'
    return
  }
  const facts = await factsFor(ids)
  const plan = planKeepLoaded(
    await machineFacts(serverPath),
    facts.map((fact) => fact.model),
    KEEP_LOADED_CTX_SIZE
  )
  if (mine !== generation) return
  if (!plan.fits || !facts.length) {
    state = 'error'
    message = plan.message ?? 'None of the chosen models is installed.'
    return
  }
  const presetFile = path.join(dataDir(), 'gateway-models.ini')
  fs.mkdirSync(path.dirname(presetFile), { recursive: true })
  fs.writeFileSync(
    presetFile,
    keepLoadedPresetIni(
      plan.models,
      Object.fromEntries(facts.map((fact) => [fact.model.id, fact.files]))
    )
  )
  const port = await pickFreePort(PREFERRED_PORT, (candidate) => isPortFree(candidate, HOST))
  if (mine !== generation) return
  if (port === null) {
    state = 'error'
    message = 'No free port for the model router.'
    return
  }
  const binDir = path.dirname(serverPath)
  const args = [
    '--models-preset',
    presetFile,
    '--models-max',
    String(facts.length),
    '--host',
    HOST,
    '--port',
    String(port),
    '--no-webui'
  ]
  console.warn(`[keep-loaded] starting router: ${serverPath} ${args.join(' ')}`)
  let proc: ChildProcess
  try {
    proc = spawn(serverPath, args, {
      env: {
        ...process.env,
        ...engineSpawnEnv({ platform: process.platform, binDir, currentEnv: process.env })
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
  } catch (error) {
    state = 'error'
    message = error instanceof Error ? error.message : String(error)
    return
  }
  router = proc
  routerPort = port
  launchedWith = serverPath
  engineUpdateReady = false
  const stderrTail: string[] = []
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    stderrTail.push(...chunk.split('\n').filter(Boolean))
    stderrTail.splice(0, Math.max(0, stderrTail.length - 20))
  })
  proc.on('error', (error) => console.error('[keep-loaded] router error:', error))
  proc.on('exit', (code) => {
    if (mine !== generation) return
    router = null
    routerPort = null
    serving = new Set()
    state = 'error'
    message =
      `The model router stopped (exit ${code ?? 'signal'}). ${stderrTail.at(-1) ?? ''}`.trim()
    console.error(`[keep-loaded] ${message}`)
    if (restarts < MAX_RESTARTS) {
      restarts += 1
      setTimeout(() => {
        if (mine === generation) void applyKeepLoaded()
      }, RESTART_DELAY_MS)
    }
  })
  if (!(await waitForRouter(proc, mine))) {
    if (mine === generation) {
      state = 'error'
      message = 'The model router did not start.'
      stopRouter()
    }
    return
  }
  serving = new Set(facts.map((fact) => fact.model.id))
  state = 'running'
  await loadMissing([...serving])
}

/** Save the set to keep loaded and restart the router with it. */
export async function setKeptModels(ids: string[]): Promise<KeepLoadedStateContract> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
    throw new Error('Pick models by id.')
  saveSetting(SETTING, [...new Set(ids)])
  restarts = 0
  await applyKeepLoaded()
  return keepLoadedState()
}

/** Stop the router (the gateway is stopping). */
export function shutdownKeepLoaded(): void {
  stopRouter()
  launchedWith = null
  state = 'off'
}

/**
 * The engines changed. An update installs each llama.cpp release in its own folder, so a router
 * still on the binary it launched with is on the old release (a model with a newer architecture
 * fails there). It keeps serving: the person restarts it when it suits them, as with an app update.
 * Returns whether an update is now waiting.
 */
export function keepLoadedEnginesChanged(): boolean {
  if (state === 'off' || launchedWith === null) return false
  const current = routerServerPath()
  engineUpdateReady = Boolean(current && current !== launchedWith)
  return engineUpdateReady
}

/** Whether a newer llama.cpp waits for the kept models (cheap: no plan, no probe). */
export function keepLoadedEngineUpdateReady(): boolean {
  return engineUpdateReady
}

/** Restart the router on the newest engine, at the person's request. */
export async function restartKeepLoaded(): Promise<KeepLoadedStateContract> {
  restarts = 0
  await applyKeepLoaded()
  return keepLoadedState()
}

/** The installed chat models the person may keep loaded. */
async function candidates(): Promise<KeepLoadedCandidateContract[]> {
  const { getCatalog, listInstalled, displayModelName } = await import('../models-manager')
  const installed = new Set(await listInstalled())
  const catalog = (await getCatalog()).models as {
    id: string
    kind: string
    name?: string
    remoteServerId?: string
  }[]
  return catalog
    .filter(
      (model) =>
        !model.remoteServerId &&
        (model.kind === 'text' || model.kind === 'vision') &&
        installed.has(model.id)
    )
    .map((model) => ({ id: model.id, name: displayModelName(model.id) ?? model.name ?? model.id }))
}

/** What the Gateway screen shows: the saved set, its plan, the router and each model's state. */
export async function keepLoadedState(ids = keptModelIds()): Promise<KeepLoadedStateContract> {
  const [available, plan, live] = await Promise.all([
    candidates(),
    planFor(ids),
    routerPort === null ? Promise.resolve(new Map()) : routerModelStatus()
  ])
  const models = ids.map((id) => ({
    id,
    status: (serving.has(id)
      ? (live.get(routerModelName(id)) ?? 'loading')
      : 'unloaded') as KeepLoadedModelStatusContract['status']
  }))
  return {
    selected: keptModelIds(),
    candidates: available,
    plan,
    router: { state, message: message ?? null, port: routerPort, engineUpdateReady },
    models
  }
}
