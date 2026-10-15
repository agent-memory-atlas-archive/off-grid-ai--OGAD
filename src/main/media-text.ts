// Text from media, for the document engine and transcription callers:
//   audio -> the active transcription service (whisper-cli by default, Parakeet when selected)
//   video -> ffmpeg (sample frames) -> vision model caption per frame
//   image -> vision model caption
// Documents (PDF, Word, text) are read by the document engine (documents/extract*). ffmpeg is
// resolved from a bundled path first, then the system. Vision captioning reuses llm.chat.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { llm } from './llm'
import { ffmpegBin } from './transcription/whisper-cli'
import { getActiveTranscription } from './transcription/select'

const execFileAsync = promisify(execFile)

export { whisperModel } from './transcription/whisper-cli'

const IMAGE_PROMPT =
  'Describe this image in detail and transcribe any visible text verbatim. Be thorough; this will be indexed for search.'

export const mediaText = {
  async transcribeAudio(p: string): Promise<string> {
    return (await getActiveTranscription().transcribe({ path: p })).text
  },

  async sampleVideoFrames(
    p: string,
    opts: { everySeconds?: number; maxFrames?: number }
  ): Promise<string[]> {
    const ff = ffmpegBin()
    if (!ff) throw new Error('ffmpeg is required to sample video frames and was not found.')
    const every = Math.max(1, opts.everySeconds ?? 5)
    const maxFrames = Math.max(1, opts.maxFrames ?? 24)
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'offgrid-frames-'))
    // One frame every `every` seconds, capped at maxFrames.
    await execFileAsync(ff, [
      '-y',
      '-i',
      p,
      '-vf',
      `fps=1/${every},scale=768:-1`,
      '-frames:v',
      String(maxFrames),
      path.join(dir, 'frame_%03d.jpg')
    ])
    const frames = (await fs.promises.readdir(dir))
      .filter((f) => f.endsWith('.jpg'))
      .sort()
      .map((f) => path.join(dir, f))
    return frames
  },

  async captionImage(imagePath: string): Promise<string> {
    // Reuse the local vision model. Requires an active vision (mmproj) model.
    return (await llm.chat(IMAGE_PROMPT, [imagePath], 300000, 1024)).trim()
  }
}
