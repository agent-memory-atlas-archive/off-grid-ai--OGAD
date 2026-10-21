#!/usr/bin/env node
// The native engine boundary for the GPU-placement launch test: a scripted llama-server.
// - `--list-devices` reports one Vulkan GPU with 8 GiB, as llama.cpp prints it.
// - Any launch that asks for the GPU (no `-ngl 0`) runs out of device memory, the way a model
//   too big for the card fails, and exits.
// - `-ngl 0` loads on the CPU and serves the endpoints LLMService waits on.
// Every launch's argv is appended, one JSON line each, to $PLACEMENT_LAUNCH_LOG.
import fs from 'node:fs'
import http from 'node:http'

const args = process.argv.slice(2)
if (args.includes('--list-devices')) {
  process.stdout.write('Available devices:\n  Vulkan0: Fake GPU (8192 MiB, 8000 MiB free)\n')
  process.exit(0)
}
if (process.env.PLACEMENT_LAUNCH_LOG) {
  fs.appendFileSync(process.env.PLACEMENT_LAUNCH_LOG, `${JSON.stringify(args)}\n`)
}
const ngl = args.indexOf('-ngl')
if (ngl < 0 || args[ngl + 1] !== '0') {
  process.stderr.write('ggml_backend_alloc_ctx_tensors_from_buft: failed to allocate buffer\n')
  process.stderr.write('llama_model_load: error loading model: out of memory\n')
  process.exit(1)
}
const port = Number(args[args.indexOf('--port') + 1])
process.stderr.write('load_tensors: offloaded 0/48 layers to GPU\n')
http
  .createServer((request, response) => {
    response.writeHead(request.url === '/health' || request.url === '/v1/models' ? 200 : 404, {
      'Content-Type': 'application/json'
    })
    response.end(request.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'fake' }] }) : '{}')
  })
  .listen(port, '127.0.0.1')
