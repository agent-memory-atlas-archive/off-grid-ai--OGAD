import { memo, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { FilePreview, type FilePreviewState } from '@offgrid/operator-ui/operator/media/file-preview'
import pdfWorkerUrl from '@offgrid/operator-ui/pdf.worker.min.mjs?url'
import { captureUrlForPath } from '../../../../../shared/ogcapture-url'
import { useMediaUrl, type MediaUrlState } from '@renderer/lib/media-url'
import { ArrowsIn } from '@phosphor-icons/react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { IconTip } from '../../IconTip'

const ease = [0.16, 1, 0.3, 1] as const
const PDF_OPTIONS = { useSystemFonts: true }
/** The viewer's toolbar row above the page, left out of the height a fitted page may use. */
const PDF_TOOLBAR_HEIGHT = 44

/** The loaded document, as the viewer's onLoadSuccess hands it over (pdf.js PDFDocumentProxy). */
interface PdfDocument {
  getPage: (n: number) => Promise<{ getViewport: (o: { scale: number }) => { width: number; height: number } }>
}

// CodeMirror's default light theme wins over the operator theme inside FilePreview; keep the
// editor on the panel surface (the same dressing the preview's file chapter uses).
const PREVIEW_SURFACE =
  'relative overflow-hidden rounded-xl [&_.cm-activeLine]:bg-transparent! [&_.cm-activeLineGutter]:bg-transparent! [&_.cm-content]:py-3! [&_.cm-editor]:rounded-xl [&_.cm-editor]:bg-foreground/[0.03]! [&_.cm-editor]:text-[12.5px] [&_.cm-gutters]:border-border/40! [&_.cm-gutters]:bg-transparent! [&_.cm-gutters]:text-muted-foreground/60!'

export interface AttachmentViewerContent {
  title: string
  text: string
  path?: string
  kind?: string
  renderer?: 'image' | 'document' | 'audio' | 'video' | 'text'
}

/**
 * A document that is not a PDF (a .docx) still opens through Chromium in a frame. The SAME
 * transport images use: the loopback media server already serves `uploads` (see media-roots.ts)
 * with canonicalisation and root admission, and captureUrlForPath is how every other local file
 * reaches the renderer.
 */
function FramedDocument({ src, title }: { src: string; title: string }): React.JSX.Element {
  return (
    <iframe
      src={src}
      title={title}
      data-og-still
      className="h-full max-h-full w-full max-w-3xl rounded-md border border-neutral-800 bg-neutral-950"
    />
  )
}

function previewFor(
  content: AttachmentViewerContent,
  src: string,
  pdfMedia: MediaUrlState,
  pdf: {
    page: number
    setPage: (page: number) => void
    scale: number
    setScale: (s: number) => void
    width: number | undefined
    onLoadSuccess: (pdf: PdfDocument) => void
  }
): FilePreviewState {
  const missing = (what: string): FilePreviewState => ({
    kind: 'unavailable',
    message: `This ${what} could not be opened. Its bytes are not on this device.`
  })
  if (content.renderer === 'audio' && content.path) {
    // A voice note, played rather than looked at: it starts as soon as it opens, as it always has.
    return src ? { kind: 'audio', src, autoPlay: true } : missing('voice note')
  }
  if (content.renderer === 'video' && content.path) {
    return src ? { kind: 'video', src } : missing('video')
  }
  if (content.renderer === 'document' && content.path) {
    // A document renders from its BYTES, served by the loopback media origin (connect-src allows it).
    // pdf.js fetches them, and a page cannot fetch the ogcapture:// scheme, so this is the media
    // server's http URL, never the capture URL the images use.
    if (pdfMedia.status === 'idle' || pdfMedia.status === 'loading') return { kind: 'loading' }
    if (pdfMedia.status !== 'ready') return missing('file')
    return {
      kind: 'pdf',
      viewer: {
        file: pdfMedia.url,
        workerSrc: pdfWorkerUrl,
        pageNumber: pdf.page,
        onPageChange: pdf.setPage,
        scale: pdf.scale,
        onScaleChange: pdf.setScale,
        // The page is drawn to fit the panel; zoom scales from there.
        ...(pdf.width ? { width: pdf.width } : {}),
        onLoadSuccess: pdf.onLoadSuccess,
        options: PDF_OPTIONS
      }
    }
  }
  return { kind: 'text', text: content.text }
}

/** The attachment viewer's body: one FilePreview surface for every kind of file. */
function AttachmentPreviewComponent({
  content
}: {
  content: AttachmentViewerContent
}): React.JSX.Element {
  const [page, setPage] = useState(1)
  const [scale, setScale] = useState(1)
  const src = content.path ? captureUrlForPath(content.path) : ''
  const framedDocument = content.renderer === 'document' && content.kind !== 'pdf' && content.path
  const pdfMedia = useMediaUrl(
    content.renderer === 'document' && !framedDocument ? content.path : null
  )
  // Fit to screen, the default: the whole page at the largest size that fits the panel's width and
  // height, from the page's own shape. The viewer otherwise draws every page 520px wide.
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<{ width: number; height: number }>()
  const [pdfDocument, setPdfDocument] = useState<PdfDocument>()
  const [aspect, setAspect] = useState<number>()
  useEffect(() => {
    const area = surfaceRef.current?.parentElement
    if (!area) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRoom({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let live = true
    void pdfDocument
      ?.getPage(page)
      .then((pdfPage) => {
        const viewport = pdfPage.getViewport({ scale: 1 })
        if (live) setAspect(viewport.width / viewport.height)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [pdfDocument, page])
  const fitWidth = room
    ? Math.max(
        240,
        Math.floor(
          aspect ? Math.min(room.width, (room.height - PDF_TOOLBAR_HEIGHT) * aspect) : room.width
        )
      )
    : undefined
  const preview = previewFor(content, src, pdfMedia, {
    page,
    setPage,
    scale,
    setScale,
    width: fitWidth,
    onLoadSuccess: setPdfDocument
  })

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={`${content.renderer ?? 'text'}:${content.path ?? content.title}`}
        initial={{ opacity: 0, y: 8, filter: 'blur(6px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        exit={{ opacity: 0, y: -4, filter: 'blur(6px)' }}
        transition={{ duration: 0.4, ease }}
        ref={surfaceRef}
        className={framedDocument ? 'h-full' : PREVIEW_SURFACE}
      >
        {framedDocument ? (
          src ? (
            <FramedDocument src={src} title={content.title} />
          ) : (
            <FilePreview
              preview={{
                kind: 'unavailable',
                message: 'This file could not be opened. Its bytes are not on this device.'
              }}
            />
          )
        ) : (
          <>
            <FilePreview preview={preview} />
            {preview.kind === 'pdf' ? (
              // Sits at the end of the viewer's own toolbar row.
              <div className="absolute right-0 top-0">
                <IconTip label="Fit to screen">
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Fit to screen"
                    disabled={scale === 1}
                    onClick={() => setScale(1)}
                  >
                    <ArrowsIn />
                  </Button>
                </IconTip>
              </div>
            ) : null}
          </>
        )}
      </motion.div>
    </AnimatePresence>
  )
}

export const AttachmentPreview = memo(AttachmentPreviewComponent)
