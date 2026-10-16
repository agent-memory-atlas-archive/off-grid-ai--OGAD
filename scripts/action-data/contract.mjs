// Request text for the planner, actor and evaluator, exactly as docs/MODEL_CONTRACT.md defines it.
// Training rows and the OGAD harness must build requests with the same functions.

const PAST_ACTIONS = 10
// Same 18k limit as OGAD's boundedSnapshot (src/main/browser/browser-playwright-policy.ts), with a
// compaction step and a cut that keeps controls: see boundedSnapshot below.
const MAX_SNAPSHOT_CHARS = 18_000
const COMMON = new Set(['open', 'find', 'tell', 'what', 'which', 'with', 'from', 'that', 'this', 'page', 'shown', 'about', 'there', 'their', 'have', 'into', 'then', 'article', 'website', 'https', 'http', 'www'])

function goalTerms(goal) {
  return [...new Set(goal.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])].filter((word) => !COMMON.has(word))
}

// Lines that carry no meaning for the models: unnamed generic wrappers and link targets.
const WRAPPER = /^\s*- generic(?: \[active\])? \[ref=[^\]]+\]:?\s*$/
const LINK_URL = /^\s*- \/url:/
const ACTIONABLE = /^\s*- '?(textbox|searchbox|combobox|checkbox|radio|button|link|option|tab|menuitem|switch|slider|spinbutton|row|cell|listitem|img)\b.*\[ref=/

/** Drop wrapper and URL lines. Refs and indentation of everything else stay as they are. */
export function compactSnapshot(snapshot) {
  return snapshot.split('\n').filter((line) => !WRAPPER.test(line) && !LINK_URL.test(line)).join('\n')
}

/**
 * The snapshot the models see: compacted, then cut to the limit if still too long. The cut keeps
 * the page header, lines about the current plan step, lines about the goal (with neighbours), then controls the actor can act on,
 * then other text — in page order. On real sites nearly every line has a ref, so a cut that only
 * prefers "lines with refs" keeps the top of the page and loses the target.
 */
export function boundedSnapshot(snapshot, goal = '', focus = '') {
  const compact = compactSnapshot(snapshot)
  if (compact.length <= MAX_SNAPSHOT_CHARS) return compact
  const lines = compact.split('\n')
  const terms = goalTerms(goal)
  const picked = new Set()
  let used = 0
  const take = (index) => {
    if (index < 0 || index >= lines.length || picked.has(index)) return
    const cost = (lines[index] ?? '').length + 1
    if (used + cost > MAX_SNAPSHOT_CHARS - 200) return
    picked.add(index)
    used += cost
  }
  const around = (index, reach) => { for (let offset = -reach; offset <= reach; offset += 1) take(index + offset) }
  for (let index = 0; index < 6; index += 1) take(index)
  // The current plan step names what the actor needs now, so its lines come first.
  const focusTerms = goalTerms(focus)
  lines.forEach((line, index) => { const lower = line.toLowerCase(); if (focusTerms.some((term) => lower.includes(term))) around(index, 1) })
  lines.forEach((line, index) => { const lower = line.toLowerCase(); if (terms.some((term) => lower.includes(term))) around(index, 1) })
  lines.forEach((line, index) => { if (ACTIONABLE.test(line)) take(index) })
  lines.forEach((_, index) => take(index))
  const kept = [...picked].sort((left, right) => left - right).map((index) => lines[index] ?? '')
  return `[Snapshot shortened. Lines about the goal, controls and their labels retained.]\n${kept.join('\n')}`
}

export function planLines(plan, current, withChecks = false) {
  return plan.map((step, index) => {
    const n = index + 1
    const mark = n < current ? '[x]' : n === current ? '[>]' : '[ ]'
    return `${mark} ${n} ${step.title}${withChecks ? ` | check: ${step.check}` : ''}`
  }).join('\n')
}

export function pastLines(past, count = PAST_ACTIONS) {
  const shown = past.slice(-count)
  const offset = past.length - shown.length
  return shown.map((entry, index) => `${offset + index + 1} ${entry}`).join('\n')
}

export function plannerRequest({ goal, snapshot, done, reason }) {
  const lines = [`GOAL: ${goal}`, 'AX:', boundedSnapshot(snapshot, goal)]
  if (done?.length) {
    lines.splice(1, 0, 'DONE:', done.map((step, i) => `[x] ${i + 1} ${step.title}`).join('\n'), `REASON: ${reason}`)
  }
  return lines.join('\n')
}

export function plannerResponse(plan, firstNumber = 1) {
  return plan.map((step, index) => `${firstNumber + index} ${step.title} | check: ${step.check}`).join('\n')
}

// Stable parts first (goal, plan), then the parts that change every step (past, image, AX), so the
// runtime can reuse the processed prefix between steps.
const focusOf = (plan, current) => plan[current - 1]?.title ?? ''

export function actorRequest({ goal, plan, current, past, snapshot }) {
  return [
    `GOAL: ${goal}`,
    'PLAN:',
    planLines(plan, current),
    'PAST:',
    past.length ? pastLines(past) : '(none)',
    '<image>',
    'AX:',
    boundedSnapshot(snapshot, goal, focusOf(plan, current))
  ].join('\n')
}

export function evaluatorRequest({ goal, plan, current, past, last, snapshot }) {
  return [
    `GOAL: ${goal}`,
    'PLAN:',
    planLines(plan, current, true),
    'PAST:',
    // LAST is usually the newest PAST entry; show the 3 actions before it.
    (() => { const prior = last === past.at(-1) ? past.slice(0, -1) : past; return prior.length ? pastLines(prior, 3) : '(none)' })(),
    `LAST: ${last}`,
    '<image>',
    'AX:',
    boundedSnapshot(snapshot, goal, focusOf(plan, current))
  ].join('\n')
}
