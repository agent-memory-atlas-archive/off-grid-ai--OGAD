// Pure SSE streaming parse + reasoning/content split, extracted from llm.ts so the
// exact area behind a past streaming bug is unit-testable WITHOUT a socket. No
// http/fs/electron imports, no side effects beyond the caller-supplied callback.
//
// Two concerns live here:
//   1. parseSseLine - turn one raw `data:` frame line into a delta (or nothing).
//   2. createThinkSplitter - a small STATEFUL pure object that takes content text
//      chunks (which may straddle a <think>...</think> tag across chunk boundaries)
//      and emits {text, kind} events, tracking the reasoning/answer channel.

import { maxPartialTagSuffix, REASONING_DELIMITERS, TOOL_CALL_OPENERS } from '@offgrid/sync'
import { QWEN_TOOL_CALL_START } from '../tools/tool-call-parse'

type DeltaKind = 'content' | 'reasoning'

export interface StreamEvent {
  text: string
  kind: DeltaKind
}

/** One streamed tool-call delta fragment. The first fragment for a given `index`
 *  carries `id` + `function.name`; subsequent fragments append `function.arguments`
 *  (the JSON args arrive as a concatenated string across fragments). */
export interface SseToolCallDelta {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/** Shape of a single streamed delta from the OpenAI-style chat-completions SSE. */
export type SseReasoningDetail = Record<string, unknown>

interface SseDelta {
  reasoning_content?: string
  /** OpenRouter can stream plain reasoning under this OpenAI-compatible alias. */
  reasoning?: string
  /** Structured reasoning used by Gemini and other remote providers. */
  reasoning_details?: SseReasoningDetail[]
  content?: string
  tool_calls?: SseToolCallDelta[]
}

/** Return only displayable reasoning. Encrypted and signature payloads stay private. */
export function displayableReasoningDelta(delta: SseDelta): string {
  if (delta.reasoning_content) return delta.reasoning_content
  if (delta.reasoning) return delta.reasoning
  return (delta.reasoning_details ?? [])
    .map((detail) =>
      typeof detail.text === 'string'
        ? detail.text
        : typeof detail.summary === 'string'
          ? detail.summary
          : ''
    )
    .filter(Boolean)
    .join('')
}

/** One parsed OpenAI-compatible SSE choice. Finish metadata lives beside the
 * delta on the wire, so keep it beside (not inside) the streamed token shape. */
/** OpenAI's token accounting, sent on the final chunk when the server reports usage. */
export interface SseUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

/**
 * llama.cpp's per-request measurements, sent alongside usage on the final chunk. Kept as its own
 * shape rather than folded into usage: these are the server's OWN measurements of its prefill and
 * decode rates, which we cannot compute from the outside, and only llama.cpp sends them.
 */
export interface SseTimings {
  prompt_n?: number
  prompt_ms?: number
  prompt_per_second?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
}

export interface SseFrame {
  delta: SseDelta
  finishReason: string | null
  usage?: SseUsage
  timings?: SseTimings
}

/** A fully-assembled tool call (after accumulating its streamed fragments). */
export interface AssembledToolCall {
  id: string
  name: string
  arguments: string // raw JSON string as sent by the model
}

/**
 * Accumulate streamed tool_call fragments (see SseToolCallDelta) into whole calls.
 * The model streams a tool call as: one fragment with {index, id, function.name} then
 * N fragments with {index, function.arguments:"<piece>"} that concatenate into the JSON
 * args. Keyed by `index` so parallel tool calls in one turn stay separate. Pure - feed
 * it each delta's tool_calls, then read `list()` when the round ends.
 */
export function createToolCallAccumulator(onReady?: (call: AssembledToolCall) => void): {
  push: (deltas: SseToolCallDelta[] | undefined) => void
  list: () => AssembledToolCall[]
  /** Report every call not yet reported as ready. Call once when the stream ends. */
  end: () => void
} {
  const byIndex = new Map<number, { id: string; name: string; args: string }>()
  const reported = new Set<number>()
  // Calls stream in index order, so a call is complete once a later index starts. Reporting it
  // then lets a caller act on it while the model is still writing the rest of the round.
  const report = (below: number): void => {
    if (!onReady) return
    for (const [index, call] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (index >= below || reported.has(index) || !call.name) continue
      reported.add(index)
      onReady({ id: call.id, name: call.name, arguments: call.args })
    }
  }
  const push = (deltas: SseToolCallDelta[] | undefined): void => {
    if (!deltas) return
    for (const d of deltas) {
      if (!byIndex.has(d.index)) report(d.index)
      const cur = byIndex.get(d.index) ?? { id: '', name: '', args: '' }
      if (d.id) cur.id = d.id
      if (d.function?.name) cur.name = d.function.name
      if (d.function?.arguments) cur.args += d.function.arguments
      byIndex.set(d.index, cur)
    }
  }
  const list = (): AssembledToolCall[] =>
    [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args }))
      .filter((c) => c.name) // drop any fragment that never got a name
  return { push, list, end: () => report(Number.POSITIVE_INFINITY) }
}

/**
 * Parse ONE line of the SSE body. Returns the first choice when the line is a
 * usable `data:` frame, or null for anything to skip (blank line, non-data line,
 * the `[DONE]` sentinel, or an unparsable/partial frame). Mirrors the original
 * inline handling exactly: trim, require the `data:` prefix, strip it, trim, skip
 * `[DONE]`, JSON-parse, reach into choices[0]. A finish-only frame is usable even
 * when its delta is omitted because the caller needs its cutoff metadata.
 */
export function parseSseLine(rawLine: string): SseFrame | null {
  const line = rawLine.trim()
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data)
    // Usage and timings arrive on a FINAL chunk that carries no choices at all, so they have to be
    // read before the choice check - that check used to drop this frame, which is why the app had
    // no idea how fast anything generated.
    const usage = (parsed?.usage ?? undefined) as SseUsage | undefined
    const timings = (parsed?.timings ?? undefined) as SseTimings | undefined
    const choice = parsed?.choices?.[0]
    if (!choice || typeof choice !== 'object') {
      return usage || timings ? { delta: {}, finishReason: null, usage, timings } : null
    }
    const delta = choice.delta
    const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null
    if (delta && typeof delta === 'object') {
      return { delta: delta as SseDelta, finishReason, usage, timings }
    }
    if (finishReason) return { delta: {}, finishReason, usage, timings }
    return null
  } catch {
    // partial / ignorable line
    return null
  }
}

/**
 * Stateful filter that suppresses tool-call MARKUP from the visible content stream.
 * Small models (gemma-4/qwen) sometimes emit a tool call as text — `<tool_call>{…}`,
 * `<|tool_call|>…`, `<invoke …>` — which the loop recovers (see tool-call-parse),
 * but the raw markup would otherwise flash in the user's answer before the tool
 * runs. Once an opener is seen, everything after it is dropped from the visible
 * stream for the rest of the turn (the tool call IS the tail of the content). It
 * only filters what the USER SEES — the caller still keeps the full text for
 * parsing. Straddle-safe: holds back a short trailing tail that could be the start
 * of an opener across chunk boundaries; `end()` flushes it if it wasn't one.
 *
 * Pure: the only side effect is the caller-supplied `emit`.
 */
export function createToolMarkupFilter(emit: (text: string) => void): {
  push: (text: string) => void
  end: () => void
} {
  const suppressOpeners = [
    ...TOOL_CALL_OPENERS,
    QWEN_TOOL_CALL_START,
    '<|tool_call|>',
    '<invoke'
  ].map((value) => value.toLowerCase())
  const thinkDelimiter = REASONING_DELIMITERS.find((delimiter) => delimiter.open === '<think>')
  const dropMarkers = thinkDelimiter
    ? [thinkDelimiter.open.toLowerCase(), thinkDelimiter.close.toLowerCase()]
    : ['<think>', '</think>']
  const partialMarkers = [...suppressOpeners, ...dropMarkers]
  let suppressing = false
  let pending = ''

  const earliest = (
    text: string,
    tokens: readonly string[]
  ): { index: number; token: string } | null => {
    const lower = text.toLowerCase()
    let found: { index: number; token: string } | null = null
    for (const token of tokens) {
      const index = lower.indexOf(token)
      if (index >= 0 && (!found || index < found.index)) found = { index, token }
    }
    return found
  }

  const push = (text: string): void => {
    if (suppressing) {
      return
    }
    pending += text
    while (pending) {
      const opener = earliest(pending, suppressOpeners)
      const marker = earliest(pending, dropMarkers)
      if (opener && (!marker || opener.index <= marker.index)) {
        if (opener.index > 0) emit(pending.slice(0, opener.index))
        suppressing = true
        pending = ''
        return
      }
      if (marker) {
        if (marker.index > 0) emit(pending.slice(0, marker.index))
        pending = pending.slice(marker.index + marker.token.length)
        continue
      }
      // Hold only a tail that can become a shared protocol marker in the next chunk.
      const holdLength = maxPartialTagSuffix(pending.toLowerCase(), partialMarkers)
      const emitLength = pending.length - holdLength
      if (emitLength > 0) emit(pending.slice(0, emitLength))
      pending = pending.slice(emitLength)
      return
    }
  }
  const end = (): void => {
    if (!suppressing && pending) {
      emit(pending)
    }
    pending = ''
  }
  return { push, end }
}

/**
 * Stateful splitter for models that inline <think>...</think> reasoning inside the
 * `content` channel. Feed it content chunks in order; it emits reasoning vs content
 * events and carries the in-think state across chunk boundaries (open tag in one
 * chunk, close in the next). It also accumulates the ANSWER text only (reasoning is
 * excluded) so the caller can resolve the final answer - matching the original
 * `full` accumulator in chatStream.
 *
 * Pure: the only side effect is invoking the caller-supplied `emit` callback.
 */
export function createThinkSplitter(emit: (ev: StreamEvent) => void): {
  push: (text: string) => void
  /** Flush a held tail that turned out not to be a tag. Call once, after the last push. */
  end: () => void
  answer: () => string
  /** The prompt opened the <think> block (the template ends with it), so the reply starts inside. */
  startInsideThinking: () => void
  /** The server separates reasoning itself (reasoning_content), so content is the answer. */
  leaveThinking: () => void
} {
  let inThink = false
  let answer = ''
  let pushed = false
  // A tag can arrive split across chunks ("</thi" then "nk>"): hold a tail that may start one.
  let pending = ''
  // Thinking the prompt opened that never closed: the model answered without thinking, so what
  // streamed as reasoning is the answer after all.
  let openedByPrompt = false
  let closed = false
  let unclosed = ''

  const out = (text: string): void => {
    if (!text) return
    if (inThink) {
      emit({ text, kind: 'reasoning' })
      if (openedByPrompt && !closed) unclosed += text
    } else {
      answer += text
      emit({ text, kind: 'content' })
    }
  }

  const push = (text: string): void => {
    pushed = true
    pending += text
    while (pending) {
      const tag = inThink ? '</think>' : '<think>'
      const at = pending.indexOf(tag)
      if (at === -1) {
        const hold = maxPartialTagSuffix(pending, [tag])
        out(pending.slice(0, pending.length - hold))
        pending = pending.slice(pending.length - hold)
        return
      }
      out(pending.slice(0, at))
      pending = pending.slice(at + tag.length)
      if (inThink) closed = true
      inThink = !inThink
    }
  }

  return {
    push,
    end: () => {
      out(pending)
      pending = ''
    },
    answer: () => (openedByPrompt && !closed && !answer ? unclosed : answer),
    startInsideThinking: () => {
      if (pushed) return
      inThink = true
      openedByPrompt = true
    },
    leaveThinking: () => {
      if (!openedByPrompt || closed) return
      inThink = false
      openedByPrompt = false
    }
  }
}
