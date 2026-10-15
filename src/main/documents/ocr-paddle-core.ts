// PaddleOCR on the app's own ONNX Runtime and sharp, through @gutenye/ocr-node. Used for scanned
// pages Apple Vision cannot read (any Indian script: Vision supports none) and on Windows/Linux,
// which have no OS OCR we can call per page. A scanned page is almost always one embedded image,
// taken straight from pdf.js's operator list (AnythingLLM's approach), so nothing is rendered.

import fs from 'node:fs'

export interface PaddleModels {
  detectionPath: string
  recognitionPath: string
  dictionaryPath: string
}

type OcrInstance = {
  detect(image: {
    data: Uint8Array
    width: number
    height: number
  }): Promise<{ texts: { text: string }[] }>
}

const engines = new Map<string, Promise<OcrInstance>>()

async function engine(models: PaddleModels | null): Promise<OcrInstance> {
  const key = models ? models.recognitionPath : 'default'
  let pending = engines.get(key)
  if (!pending) {
    pending = import('@gutenye/ocr-node').then(({ default: Ocr }) =>
      (
        Ocr as unknown as { create(options?: { models?: PaddleModels }): Promise<OcrInstance> }
      ).create(models ? { models } : {})
    )
    pending.catch(() => engines.delete(key))
    engines.set(key, pending)
  }
  return pending
}

type PdfImage = {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
  kind?: number
}

/** pdf.js image kinds: 1 = 1 bit grayscale (set bit is white), 2 = RGB, 3 = RGBA. */
function toRgba(image: PdfImage): Uint8Array {
  const { width, height, data } = image
  const out = new Uint8Array(width * height * 4)
  if (image.kind === 3) {
    out.set(data.subarray(0, out.length))
    return out
  }
  if (image.kind === 2) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) {
      out[i * 4] = data[j]!
      out[i * 4 + 1] = data[j + 1]!
      out[i * 4 + 2] = data[j + 2]!
      out[i * 4 + 3] = 255
    }
    return out
  }
  const rowBytes = Math.ceil(width / 8)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = (data[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1
      const value = bit ? 255 : 0
      const o = (y * width + x) * 4
      out[o] = out[o + 1] = out[o + 2] = value
      out[o + 3] = 255
    }
  }
  return out
}

/** The largest image drawn on a page, when it covers most of it (a scan). */
async function pageImage(
  page: {
    getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>
    objs: { get(id: string, callback: (value: unknown) => void): void }
    commonObjs: { get(id: string, callback: (value: unknown) => void): void }
    getViewport(options: { scale: number }): { width: number; height: number }
  },
  ops: Record<string, number>
): Promise<PdfImage | null> {
  const list = await page.getOperatorList()
  const ids: string[] = []
  list.fnArray.forEach((fn, i) => {
    if (
      fn === ops.paintImageXObject ||
      fn === ops.paintJpegXObject ||
      fn === ops.paintImageXObjectRepeat
    ) {
      const id = list.argsArray[i]?.[0]
      if (typeof id === 'string') ids.push(id)
    }
  })
  let best: PdfImage | null = null
  for (const id of ids) {
    const store = id.startsWith('g_') ? page.commonObjs : page.objs
    const image = await new Promise<PdfImage | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000)
      store.get(id, (value) => {
        clearTimeout(timer)
        const candidate = value as PdfImage | null
        resolve(candidate?.width && candidate.height ? candidate : null)
      })
    })
    if (image && (!best || image.width * image.height > best.width * best.height)) best = image
  }
  return best
}

/** OCR the given pages of a PDF. Pages with no scan image come back with empty text. */
export async function paddleOcrPages(
  pdfPath: string,
  pages: number[],
  models: PaddleModels | null,
  signal?: AbortSignal
): Promise<{ page: number; text: string }[]> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as typeof import('pdfjs-dist')
  const sharp = (await import('sharp')).default
  const ocr = await engine(models)
  const document = await pdfjs.getDocument({
    data: new Uint8Array(await fs.promises.readFile(pdfPath)),
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0
  }).promise
  const results: { page: number; text: string }[] = []
  try {
    for (const number of pages) {
      if (signal?.aborted) break
      let text = ''
      try {
        const page = await document.getPage(number)
        const image = await pageImage(page as never, pdfjs.OPS as unknown as Record<string, number>)
        if (image) {
          // Downscale very large scans: detection works on a ~960 px side anyway.
          const { data, info } = await sharp(Buffer.from(toRgba(image)), {
            raw: { width: image.width, height: image.height, channels: 4 }
          })
            .flatten({ background: '#ffffff' })
            .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true })
          const detected = await ocr.detect({
            data: new Uint8Array(data),
            width: info.width,
            height: info.height
          })
          text = detected.texts.map((line) => line.text).join('\n')
        }
        page.cleanup()
      } catch {
        // A page that fails stays unread; the rest continue.
      }
      results.push({ page: number, text })
    }
  } finally {
    await document.destroy()
  }
  return results
}
