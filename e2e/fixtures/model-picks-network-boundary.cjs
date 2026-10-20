/**
 * Hugging Face delivery boundary for the device-picks journey.
 *
 * A model file request is answered from the host's own copy of that file (same name), so the
 * journey downloads real weights without the network. Off Grid AI still owns the catalog, the
 * picks, the download queue, verification, promotion, activation and the engine. Any file the host
 * does not have goes to the real network.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Electron loads this CommonJS bootstrap before the production bundle. */
const fs = require('node:fs')
const path = require('node:path')

const sourceDir = process.env.OFFGRID_PICKS_SOURCE_DIR
if (!sourceDir) throw new Error('OFFGRID_PICKS_SOURCE_DIR is required')

function fileBody(filePath) {
  const size = fs.statSync(filePath).size
  const descriptor = fs.openSync(filePath, 'r')
  let offset = 0
  return {
    size,
    body: new ReadableStream({
      pull(controller) {
        if (offset >= size) {
          fs.closeSync(descriptor)
          controller.close()
          return
        }
        const chunk = Buffer.allocUnsafe(Math.min(16 * 1024 * 1024, size - offset))
        const read = fs.readSync(descriptor, chunk, 0, chunk.length, offset)
        offset += read
        controller.enqueue(chunk.subarray(0, read))
      },
      cancel() {
        fs.closeSync(descriptor)
      }
    })
  }
}

const originalFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = async (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const match = /huggingface\.co\/.+\/resolve\/[^/]+\/(.+?)(?:\?|$)/.exec(target)
  const local = match ? path.join(sourceDir, path.basename(decodeURIComponent(match[1]))) : null
  if (!local || !fs.existsSync(local)) return originalFetch(input, init)
  const delivery = fileBody(local)
  return new Response(delivery.body, {
    status: 200,
    headers: { 'content-length': String(delivery.size) }
  })
}

const electron = require('electron')
electron.app.setAppPath(path.resolve(__dirname, '../..'))
electron.app.setPath('userData', process.env.OFFGRID_USER_DATA)
require('../../out/main/index.js')
