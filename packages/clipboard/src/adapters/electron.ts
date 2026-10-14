// Electron clipboard bridge for desktop (Electron main process).
// Ports copyclip's clipboard-monitor extraction logic (MIT) behind the
// ClipboardBridge interface. Electron is injected by the host so this package
// never imports 'electron' directly and stays installable on mobile.

import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import type { ClipboardBridge, ClipboardItem, ClipboardRead } from '../types'

/** Minimal shape of Electron's nativeImage instances we use. */
interface ElectronImage {
  isEmpty(): boolean
  toPNG(): Buffer
}

/** Minimal shape of Electron's clipboard module we use. */
export interface ElectronClipboard {
  availableFormats(): string[]
  readImage(): ElectronImage
  readRTF(): string
  readText(): string
  readBuffer(format: string): Buffer
  read(format: string): string
  writeText(text: string): void
  writeRTF(text: string): void
  writeImage(image: ElectronImage): void
}

/** Minimal shape of Electron's nativeImage module we use. */
export interface ElectronNativeImage {
  createFromBuffer(buffer: Buffer): ElectronImage
}

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB

/** Finder file reference URL, e.g. file:///.file/id=6571367.12345678 */
const FILE_REFERENCE_URL = /^file:\/\/\/\.file\/id=[\d.]+\/?$/

/** Signals that a file reference URL is still resolving; the poll skips this tick. */
const PENDING = Symbol('pending')

export class ElectronClipboardBridge implements ClipboardBridge {
  constructor(
    private readonly clipboard: ElectronClipboard,
    private readonly nativeImage: ElectronNativeImage
  ) {}

  // The poll reads the clipboard every 500 ms. Resolving a Finder reference spawns
  // osascript, so it runs off the main thread once per URL and is reused afterwards.
  private reference: { url: string; path: string | null } | null = null
  private resolving: string | null = null

  read(): ClipboardRead | null {
    const formats = this.clipboard.availableFormats()
    if (formats.length === 0) return null
    const extracted = this.extract(formats)
    if (extracted === PENDING) return null
    if (!extracted.rawData || extracted.rawData.length === 0) return null
    return extracted
  }

  write(item: ClipboardItem): void {
    switch (item.contentType) {
      case 'image': {
        const img = this.nativeImage.createFromBuffer(Buffer.from(item.rawData))
        this.clipboard.writeImage(img)
        return
      }
      case 'rtf': {
        const rtf = Buffer.from(item.rawData).toString('utf-8')
        this.clipboard.writeRTF(rtf)
        if (item.textContent) this.clipboard.writeText(item.textContent)
        return
      }
      default: {
        const text = item.textContent ?? Buffer.from(item.rawData).toString('utf-8')
        this.clipboard.writeText(text)
      }
    }
  }

  private extract(formats: string[]): ClipboardRead | typeof PENDING {
    // Image first.
    if (formats.some((f) => f.includes('image'))) {
      const image = this.clipboard.readImage()
      if (!image.isEmpty()) {
        return { contentType: 'image', rawData: image.toPNG(), textContent: null }
      }
    }

    // RTF.
    if (formats.includes('text/rtf')) {
      const rtf = this.clipboard.readRTF()
      const text = this.clipboard.readText()
      if (rtf) {
        return { contentType: 'rtf', rawData: Buffer.from(rtf, 'utf-8'), textContent: text || null }
      }
    }

    // File paths (macOS Finder).
    if (formats.includes('public.file-url') || formats.includes('text/uri-list')) {
      const fileRead = this.extractFile()
      if (fileRead) return fileRead
    }

    // Plain text.
    const text = this.clipboard.readText()
    if (text) {
      return { contentType: 'text', rawData: Buffer.from(text, 'utf-8'), textContent: text }
    }

    return { contentType: 'text', rawData: Buffer.from(''), textContent: null }
  }

  private extractFile(): ClipboardRead | typeof PENDING | null {
    const macOSFileTypes = [
      'public.file-url',
      'NSFilenamesPboardType',
      'com.apple.nspasteboard.promised-file-url',
      'dyn.ah62d4rv4gu8y',
      'text/uri-list'
    ]

    let fileUrl: string | null = null
    for (const formatType of macOSFileTypes) {
      if (fileUrl) break
      try {
        const buffer = this.clipboard.readBuffer(formatType)
        if (buffer && buffer.length > 0) {
          let parsed = buffer.toString('utf-8').replace(/\0/g, '').trim()
          if (formatType === 'NSFilenamesPboardType' && parsed.includes('<?xml')) {
            const m = parsed.match(/<string>([^<]+)<\/string>/)
            if (m) parsed = m[1]
          }
          if (parsed.includes('\n')) parsed = parsed.split('\n')[0].trim()
          if (parsed && (parsed.startsWith('/') || parsed.startsWith('file://'))) fileUrl = parsed
        }
      } catch {
        // not all formats are readable
      }
    }

    if (!fileUrl) {
      const text = this.clipboard.readText()
      if (text && (text.startsWith('/') || text.startsWith('file://'))) fileUrl = text
    }

    if (!fileUrl || !(fileUrl.startsWith('/') || fileUrl.startsWith('file://'))) return null

    const resolved = this.resolveReference(fileUrl)
    if (resolved === PENDING) return PENDING
    const filePath = resolved
      ? resolved
      : fileUrl.startsWith('file://')
        ? decodeURIComponent(fileUrl.replace('file://', ''))
        : fileUrl

    try {
      const stats = fs.statSync(filePath)
      if (stats.isFile() && stats.size <= MAX_FILE_SIZE) {
        return {
          contentType: 'file',
          rawData: fs.readFileSync(filePath),
          textContent: path.basename(filePath)
        }
      }
      if (stats.isFile() && stats.size > MAX_FILE_SIZE) {
        return {
          contentType: 'text',
          rawData: Buffer.from(fileUrl, 'utf-8'),
          textContent: `[File too large: ${path.basename(filePath)}]`
        }
      }
    } catch {
      // fall through to storing the path as text
    }

    return { contentType: 'text', rawData: Buffer.from(fileUrl, 'utf-8'), textContent: fileUrl }
  }

  /** Resolved path for a Finder reference URL, PENDING while osascript runs, or null
   *  for a normal URL. Only the current clipboard URL is cached. */
  private resolveReference(fileUrl: string): string | null | typeof PENDING {
    if (!FILE_REFERENCE_URL.test(fileUrl)) return null
    if (this.reference?.url === fileUrl) return this.reference.path
    if (this.resolving !== fileUrl) {
      this.resolving = fileUrl
      void resolveFileReferenceUrl(fileUrl).then((resolved) => {
        if (this.resolving !== fileUrl) return
        this.reference = { url: fileUrl, path: resolved }
        this.resolving = null
      })
    }
    return PENDING
  }
}

/**
 * Resolve macOS file reference URLs (file:///.file/id=...) that Finder uses,
 * via AppleScript / NSURL. Ported from copyclip; runs asynchronously so the
 * main process never waits on osascript.
 */
function resolveFileReferenceUrl(fileUrl: string): Promise<string | null> {
  const script = `
    use framework "Foundation"
    set theURL to current application's NSURL's URLWithString:"${fileUrl}"
    set resolvedURL to theURL's filePathURL()
    if resolvedURL is not missing value then
      return (resolvedURL's |path|()) as text
    else
      return ""
    end if
  `
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
      const result = err ? '' : stdout.trim()
      resolve(result.startsWith('/') ? result : null)
    })
  })
}
