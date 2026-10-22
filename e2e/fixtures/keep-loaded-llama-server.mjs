#!/usr/bin/env node

// The keep-loaded spec's only fake: the native llama-server executable. Launched with
// --models-preset it behaves as llama.cpp's router: it reads the preset the app wrote, lists each
// section on GET /models, loads on POST /models/load, and answers a chat as the model it names.
// Launched without one it is the chat engine for the active model.

import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const port = Number(flag('--port') ?? 8439)
const presetFile = flag('--models-preset')

/** Section name → its keys, from the INI the app wrote. */
const presets = new Map()
if (presetFile) {
  let section = null
  for (const line of fs.readFileSync(presetFile, 'utf8').split('\n')) {
    const header = /^\[(.+)\]$/.exec(line.trim())
    if (header) {
      section = new Map()
      presets.set(header[1], section)
      continue
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line)
    if (section && pair) section.set(pair[1], pair[2])
  }
}
const loaded = new Set(
  [...presets].filter(([, keys]) => keys.get('load-on-startup') === 'true').map(([id]) => id)
)

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const send = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = http.createServer((request, response) => {
  let raw = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => (raw += chunk))
  request.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    if (request.method === 'GET' && request.url === '/health') return send(response, 200, { status: 'ok' })
    if (presetFile && request.method === 'GET' && request.url === '/models') {
      return send(response, 200, {
        data: [...presets].map(([id, keys]) => ({
          id,
          path: keys.get('model'),
          status: { value: loaded.has(id) ? 'loaded' : 'unloaded' }
        }))
      })
    }
    if (presetFile && request.method === 'POST' && request.url === '/models/load') {
      if (!presets.has(body.model)) return send(response, 404, { success: false })
      loaded.add(body.model)
      return send(response, 200, { success: true })
    }
    if (request.method === 'GET' && request.url === '/v1/models')
      return send(response, 200, { data: [{ id: 'active-model' }] })
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const keys = presetFile ? presets.get(body.model) : undefined
      if (presetFile && !keys) return send(response, 400, { error: { message: 'model not found' } })
      // The router answers as the model, and says what it was launched with.
      const content = presetFile
        ? `kept ${body.model} threads=${keys.get('threads')} poll=${keys.get('poll')}`
        : 'chat engine'
      return send(response, 200, {
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    }
    response.writeHead(404)
    response.end()
  })
})

server.listen(port, '127.0.0.1')
const stop = () => server.close(() => process.exit(0))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
