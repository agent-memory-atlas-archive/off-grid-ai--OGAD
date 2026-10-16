// Re-render the AX part of ms-swift rows with the current contract code (compaction and the
// focused cut), so rows captured with an older contract match what the harness sends now.
//   node rerender.mjs <file.jsonl> [...]   (rewrites each file in place)
// The goal comes from the GOAL line and the focus from the [>] plan line, as the harness does.

import { readFileSync, writeFileSync } from 'node:fs'
import { boundedSnapshot } from '../contract.mjs'

const SHORTENED = '[Snapshot shortened.'

for (const file of process.argv.slice(2)) {
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  let changed = 0
  for (const row of rows) {
    const user = row.messages.find((m) => m.role === 'user')
    const at = user.content.indexOf('\nAX:\n')
    if (at < 0) continue
    const head = user.content.slice(0, at)
    const ax = user.content.slice(at + 5)
    if (ax.startsWith(SHORTENED)) continue // already cut by an older contract; its full text is gone
    const goal = (head.match(/^GOAL: (.*)$/m) ?? [])[1] ?? ''
    const focus = (head.match(/^\[>\] \d+ (.*?)(?: \| check:.*)?$/m) ?? [])[1] ?? ''
    const next = `${head}\nAX:\n${boundedSnapshot(ax, goal, focus)}`
    if (next !== user.content) { user.content = next; changed++ }
  }
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(JSON.stringify({ file, rows: rows.length, changed }))
}
