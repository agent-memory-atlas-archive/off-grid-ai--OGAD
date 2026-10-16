// One capture worker. It opens generated pages in Chromium, observes them through the same
// Playwright MCP connection and settings that OGAD's Web Use uses, and runs the loop from
// docs/MODEL_CONTRACT.md: planner → (evaluator → actor → harness)*. The label script plays all
// three models; every action is run and its effect checked before its row is kept.
//
// node scripts/action-data/capture.mjs --worker 0 --episodes 50 --out outputs/action-data/run1

import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { createConnection } from '@playwright/mcp'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { generatePage } from './page-gen.mjs'
import { generateTask, correctActions, initialPlan, verdict, replan } from './tasks.mjs'
import { FLOW_FAMILIES, generateFlow, flowPlan, flowVerdict, flowReplan, flowActions } from './flows.mjs'
import { plannerRequest, plannerResponse, actorRequest, evaluatorRequest } from './contract.mjs'
import { createRng } from './rng.mjs'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]])
  return pairs
}, []))
const worker = Number(args.worker ?? 0)
const episodes = Number(args.episodes ?? 10)
const runSeed = args.seed ?? 'pilot'
const out = args.out ?? 'outputs/action-data/pilot'
// --family form or --family form:2,list:1 (weights). Empty: the generator's own mix.
const FAMILIES = (args.family || '').split(',').filter(Boolean).map((part) => {
  const [name, weight] = part.split(':')
  return { name, weight: Number(weight ?? 1) }
})
const port = 9400 + worker
const MAX_STEPS = 500
const NOISE = Number(args.noise ?? 0.12)
// OGAD waits 350 ms after each action. Generated pages change at once (a save takes 700 ms or
// more, so "Saving…" is still captured), so the wait changes nothing here and costs time. Use
// --settle 350 for real sites.
const SETTLE = Number(args.settle ?? 0)
const REF_LINE = /^(\s*)- (.*?)\s*\[ref=((?:f\d+)?e\d+)\]/
// Roles a label can target. Wrappers, text and headings never carry a data-gen-id target.
// Snapshot lines whose name has a colon are YAML-quoted: - 'checkbox "A: B" [ref=e1]'
const TARGET_ROLES = /^'?(textbox|searchbox|combobox|checkbox|radio|button|link|row|group|spinbutton|slider|switch|tab|menuitem|option)\b/
const VIEWPORTS = [[1280, 800], [1440, 900], [1024, 768], [1600, 1000]]

mkdirSync(join(out, 'images'), { recursive: true })
const files = {
  actor: join(out, `actor-w${worker}.jsonl`),
  evaluator: join(out, `evaluator-w${worker}.jsonl`),
  planner: join(out, `planner-w${worker}.jsonl`),
  episodes: join(out, `episodes-w${worker}.jsonl`)
}
const write = (file, row) => appendFileSync(file, `${JSON.stringify(row)}\n`)

process.setMaxListeners(0)
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: [`--remote-debugging-port=${port}`]
})
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
const page = await context.newPage()
let current = null
await context.route('**/*', (route) => {
  const url = new URL(route.request().url())
  if (current && url.hostname === current.spec.domain && url.pathname === current.spec.path) {
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: current.html })
  }
  return route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not found</h1>' })
})

// Same connection options as src/main/browser/playwright-mcp-session.ts, except settle (above).
const server = await createConnection({
  browser: { browserName: 'chromium', cdpEndpoint: `http://127.0.0.1:${port}` },
  capabilities: ['core', 'core-navigation', 'core-tabs', 'core-input'],
  imageResponses: 'omit',
  snapshot: { mode: 'none', boxes: false },
  timeouts: { action: 10_000, navigation: 45_000, settle: SETTLE }
})
const client = new Client({ name: 'Off Grid AI action-data', version: '1' })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

async function tool(name, toolArgs) {
  const result = await client.callTool({ name, arguments: toolArgs })
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n')
  return { text, isError: Boolean(result.isError) || text.startsWith('### Error') }
}

const totals = { episodes: 0, completed: 0, actorRows: 0, evaluatorRows: 0, plannerRows: 0, actions: 0, verdicts: {}, families: {}, reasons: {} }
const started = Date.now()

for (let n = 0; n < episodes; n++) {
  const seed = `${runSeed}:w${worker}:e${n}`
  try {
    const result = await runEpisode(seed)
    totals.episodes++
    totals.families[result.family] = (totals.families[result.family] ?? 0) + 1
    if (result.completed) totals.completed++
    else totals.reasons[result.reason] = (totals.reasons[result.reason] ?? 0) + 1
    write(files.episodes, { seed, ...result })
  } catch (error) {
    totals.reasons.crash = (totals.reasons.crash ?? 0) + 1
    write(files.episodes, { seed, completed: false, reason: 'crash', error: String(error?.stack ?? error).slice(0, 600) })
    // A closed browser or a full disk fails every later task too: stop instead of logging empty tasks.
    if (/has been closed|system error -122|ENOSPC|EDQUOT/.test(String(error))) break
  }
}
writeFileSync(join(out, `summary-w${worker}.json`), JSON.stringify({ ...totals, seconds: (Date.now() - started) / 1000 }, null, 2))
await client.close()
await browser.close()

async function runEpisode(seed) {
  const rng = createRng(`${seed}:run`)
  const family = pickFamily(rng)
  let task
  if (FLOW_FAMILIES.includes(family)) {
    const flow = generateFlow(seed, family)
    current = { spec: flow.spec, html: flow.html }
    task = flow.task
  } else {
    current = generatePage(seed, family)
    task = generateTask(current.spec, seed)
  }
  const { spec } = current
  // Consumer flows and the older families share the loop; only the label script differs.
  const L = spec.flow
    ? { plan: () => flowPlan(task), verdict: (p, st) => flowVerdict(task, p, st), replan: (p, st) => flowReplan(task, p, st), actions: (st) => flowActions(spec, task, st) }
    : { plan: (st) => initialPlan(spec, task, st), verdict: (p, st) => verdict(spec, task, p, st), replan: (p, st) => replan(spec, task, p, st), actions: (st) => correctActions(spec, task, st) }
  const [width, height] = rng.pick(VIEWPORTS)
  await page.setViewportSize({ width, height })
  const url = `https://${spec.domain}${spec.path}`
  const nav = await tool('browser_navigate', { url })
  if (nav.isError) return { family: spec.family, completed: false, reason: 'navigate', actions: 0 }
  await page.waitForFunction(() => Boolean(window.__og))

  const refCache = new Map()
  const past = []
  let step = 0
  let obs = await observe(seed, step)
  let plan = L.plan(obs.state)
  write(files.planner, { id: `${seed}:plan0`, seed, kind: 'plan', request: plannerRequest({ goal: task.goal, snapshot: obs.snapshot }), response: plannerResponse(plan) })
  totals.plannerRows++
  let marker = 1
  let last = 'task started'
  let actions = 0

  while (actions < MAX_STEPS) {
    // Evaluator: judge the current screen.
    const judged = L.verdict(plan, obs.state)
    const name = judged.verdict.split('(')[0]
    totals.verdicts[name] = (totals.verdicts[name] ?? 0) + 1
    write(files.evaluator, {
      id: `${seed}:e${step}`, seed, step, family: spec.family,
      request: evaluatorRequest({ goal: task.goal, plan, current: marker, past, last, snapshot: obs.snapshot }),
      image: obs.image, response: judged.verdict
    })
    totals.evaluatorRows++
    if (name === 'success' || name === 'fail') return { family: spec.family, completed: true, end: judged.verdict, actions }
    if (name === 'takeover') {
      const did = await page.evaluate(() => window.__og.userResolve())
      await page.waitForTimeout(400)
      last = `user took over -> ${did}`
      obs = await observe(seed, ++step)
      continue
    }
    if (name === 'replan') {
      const { done, remaining } = L.replan(plan, obs.state)
      write(files.planner, {
        id: `${seed}:plan${step}`, seed, kind: 'replan',
        request: plannerRequest({ goal: task.goal, snapshot: obs.snapshot, done, reason: judged.reason }),
        response: plannerResponse(remaining, done.length + 1)
      })
      totals.plannerRows++
      plan = [...done, ...remaining]
      marker = done.length + 1
    } else {
      marker = judged.current
    }

    // Actor: one action for the current screen.
    const genToRef = await resolveRefs(obs.snapshot, refCache)
    const wanted = L.actions(obs.state)
    const accepted = wanted.map((a) => toRefs(a, genToRef)).filter(Boolean)
    if (!accepted.length) return { family: spec.family, completed: false, reason: wanted.length ? 'unresolved-target' : 'no-action', actions, wanted, verdict: judged.verdict }
    const wrong = actions > 0 && name === 'continue' && rng.chance(NOISE) ? wrongAction(spec, task, genToRef, rng, accepted) : null
    const noisy = Boolean(wrong)
    const executed = wrong ?? chooseAction(accepted, rng)
    if (!noisy) {
      write(files.actor, {
        id: `${seed}:a${step}`, seed, step, family: spec.family, viewport: [width, height],
        request: actorRequest({ goal: task.goal, plan, current: marker, past, snapshot: obs.snapshot }),
        image: obs.image, response: executed, accepted
      })
      totals.actorRows++
    }

    // Harness: run it and record the result.
    const outcome = await execute(executed, obs.snapshot)
    const before = obs
    obs = await observe(seed, ++step)
    actions++
    totals.actions++
    const result = outcome.isError
      ? `${outcome.timeout ? 'timeout' : 'error'} ${compact(outcome.text)}`
      : obs.snapshot !== before.snapshot ? 'ok, page changed' : 'ok, no visible change'
    if (!noisy && !checkEffect(executed, before.state, obs.state, genToRef)) {
      return { family: spec.family, completed: false, reason: `check-failed:${executed.split('(')[0]}`, actions, detail: compact(outcome.text) }
    }
    last = `${executed} -> ${result}`
    past.push(last)
  }
  return { family: spec.family, completed: false, reason: 'max-steps', actions }
}

function pickFamily(rng) {
  if (!FAMILIES.length) return undefined
  let roll = rng.next() * FAMILIES.reduce((sum, f) => sum + f.weight, 0)
  for (const f of FAMILIES) {
    roll -= f.weight
    if (roll < 0) return f.name
  }
  return FAMILIES.at(-1).name
}

async function observe(seed, step) {
  const state = await page.evaluate(() => window.__og.state())
  const snapshot = (await tool('browser_snapshot', { boxes: false })).text
  const image = `images/${safe(seed)}-s${step}.jpg`
  await page.screenshot({ path: join(out, image), type: 'jpeg', quality: 70 })
  return { state, snapshot, image }
}

// ---------- refs ----------

/**
 * Map data-gen-id → snapshot ref, asking the page only about target refs not seen before.
 * The lookups run in parallel, so any settle wait is paid once per step.
 */
async function resolveRefs(snapshot, cache) {
  const lines = snapshot.split('\n').map((line) => line.match(REF_LINE)).filter(Boolean)
  const fresh = lines.filter(([, , description, ref]) => !cache.has(ref) && TARGET_ROLES.test(description))
  await Promise.all(fresh.map(async ([, , description, ref]) => {
    const result = await tool('browser_evaluate', {
      element: description.slice(0, 80),
      target: ref,
      function: '(el) => (el && el.dataset && el.dataset.genId) || null'
    })
    const value = result.isError ? null : JSON.parse(result.text.match(/### Result\n(.*)/)?.[1] ?? 'null')
    cache.set(ref, { genId: value, description })
  }))
  const genToRef = new Map()
  for (const [, , description, ref] of lines) {
    const genId = cache.get(ref)?.genId
    if (genId && !genToRef.has(genId)) genToRef.set(genId, { ref, description })
  }
  return genToRef
}

/** `click(@f3)` → `click(e12)`. Null when the target is not in this snapshot. */
function toRefs(action, genToRef) {
  let missing = false
  const out = action.replace(/(?<=[(,])@([\w-]+)/g, (_, genId) => {
    const hit = genToRef.get(genId)
    if (!hit) missing = true
    return hit?.ref ?? ''
  })
  return missing ? null : out
}

// ---------- choosing and running actions ----------

function chooseAction(accepted, rng) {
  const pick = rng.chance(0.7) ? accepted[0] : rng.pick(accepted)
  return pick === 'wait(*)' ? `wait(${rng.pick([1000, 1500, 2000, 3000])})` : pick
}

/** A plausible wrong step: it teaches the evaluator to re-plan and gives recovery states. */
function wrongAction(spec, task, genToRef, rng, accepted) {
  if (spec.family === 'feed') {
    // Like a post the goal did not ask for: the evaluator must re-plan and the actor undo it.
    const wanted = new Set(task.steps.map((st) => st.action.id))
    const others = spec.posts.filter((p) => !wanted.has(p.likeId) && genToRef.has(p.likeId))
    return others.length ? `click(${genToRef.get(rng.pick(others).likeId).ref})` : null
  }
  if (spec.flow) return null
  const navs = spec.nav.filter((n) => genToRef.has(n.id))
  const targets = new Set((task.targets ?? []).map((t) => t.id))
  const fields = (spec.pages ?? []).flatMap((p) => p.sections.flatMap((s) => s.fields))
    .filter((f) => ['text', 'email', 'tel', 'number', 'textarea'].includes(f.kind) && !targets.has(f.id) && genToRef.has(f.id))
  const goalRefs = new Set(accepted.join(' ').match(/(?:f\d+)?e\d+/g) ?? [])
  const wrong = fields.filter((f) => !goalRefs.has(genToRef.get(f.id).ref))
  if (wrong.length && rng.chance(0.5)) return `type(${genToRef.get(rng.pick(wrong).id).ref},"test")`
  if (navs.length) return `click(${genToRef.get(rng.pick(navs).id).ref})`
  return null
}

function parseCall(action) {
  const [, name, body] = action.match(/^(\w+)\((.*)\)$/s)
  const parts = body ? JSON.parse(`[${body.replace(/(^|,)((?:f\d+)?e\d+)(?=,|$)/g, '$1"$2"')}]`) : []
  return { name, parts }
}

async function execute(action, snapshot) {
  const { name, parts } = parseCall(action)
  const element = (ref) => snapshot.split('\n').map((l) => l.match(REF_LINE)).find((m) => m?.[3] === ref)?.[2] ?? ref
  switch (name) {
    case 'click':
    case 'check':
    case 'uncheck':
      return tool('browser_click', { element: element(parts[0]), target: parts[0] })
    case 'type':
      return tool('browser_type', { element: element(parts[0]), target: parts[0], text: parts[1], submit: false, slowly: false })
    case 'clear':
      return tool('browser_type', { element: element(parts[0]), target: parts[0], text: '', submit: false, slowly: false })
    case 'select':
      return tool('browser_select_option', { element: element(parts[0]), target: parts[0], values: [parts[1]] })
    case 'press':
      return tool('browser_press_key', { key: parts[0] })
    case 'scroll_down':
    case 'scroll_up':
      return tool('browser_evaluate', { function: `() => { window.scrollBy(0, ${name === 'scroll_up' ? '-' : ''}Math.round(innerHeight * 0.8)); return 'scrolled' }` })
    case 'back':
      return tool('browser_navigate_back', {})
    case 'wait':
    case 'wait_idle': {
      try {
        await page.waitForFunction(() => !window.__og.state().saving, null, { timeout: Math.max(Number(parts[0]) || 0, 5000) })
        await page.waitForTimeout(350)
        return { text: 'ok', isError: false }
      } catch {
        return { text: 'the page kept loading', isError: true, timeout: true }
      }
    }
    default:
      return { text: `unsupported action ${name}`, isError: true }
  }
}

/** The label is kept only if running it had the effect the label script expected. */
function checkEffect(action, before, after, genToRef) {
  const { name, parts } = parseCall(action)
  const refToGen = new Map([...genToRef].map(([genId, { ref }]) => [ref, genId]))
  const gid = parts[0] && refToGen.get(parts[0])
  const changed = JSON.stringify({ ...after, visible: null }) !== JSON.stringify({ ...before, visible: null }) || after.visible.join() !== before.visible.join()
  switch (name) {
    case 'type': return after.values[gid] === parts[1]
    case 'clear': return after.values[gid] === ''
    case 'select': return after.values[gid] === parts[1]
    case 'check': case 'uncheck': case 'click': {
      if (gid && /^f\d+-\d+$/.test(gid)) return after.values[gid.replace(/-\d+$/, '')] !== before.values[gid.replace(/-\d+$/, '')]
      if (gid && typeof after.values[gid] === 'boolean') return after.values[gid] !== before.values[gid]
      return changed
    }
    case 'press': return changed
    case 'scroll_down': case 'scroll_up': return after.scrollY !== before.scrollY || after.loaded !== before.loaded
    case 'back': return after.view !== before.view
    case 'wait': case 'wait_idle': return !after.saving
    default: return false
  }
}

function compact(text) {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 120)
}

function safe(text) {
  return text.replace(/[^\w-]+/g, '_')
}
