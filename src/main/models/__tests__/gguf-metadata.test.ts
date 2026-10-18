import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseGgufMetadata,
  parseGgufChatTemplate,
  chatTemplateDeclaresTools,
  readGgufTemplateTraits,
  readGgufContextLength,
  GGUF_METADATA_PREFIX_BYTES
} from '../gguf-metadata'

// --- Minimal GGUF (v3) byte-builder, so the parser is tested against real bytes, not a fake. ---
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}
const gstr = (s: string): Buffer => {
  const body = Buffer.from(s, 'utf8')
  return Buffer.concat([u64(body.length), body])
}
const kvString = (key: string, val: string): Buffer =>
  Buffer.concat([gstr(key), u32(8 /* STRING */), gstr(val)])
const kvU32 = (key: string, val: number): Buffer =>
  Buffer.concat([gstr(key), u32(4 /* UINT32 */), u32(val)])
const kvU64 = (key: string, val: number): Buffer =>
  Buffer.concat([gstr(key), u32(10 /* UINT64 */), u64(val)])
// A STRING array whose DECLARED length far exceeds the strings actually present — reading it would
// run off the end of the buffer (throw). Used to prove the parser short-circuits before the
// tokenizer array and never touches it.
const kvOversizedStringArray = (key: string): Buffer =>
  Buffer.concat([
    gstr(key),
    u32(9 /* ARRAY */),
    u32(8 /* STRING elem */),
    u64(1_000_000),
    gstr('a')
  ])
const buildGguf = (kvs: Buffer[], version = 3): Buffer =>
  Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(version),
    u64(0 /* tensors */),
    u64(kvs.length),
    ...kvs
  ])

describe('parseGgufMetadata', () => {
  it('reads architecture and the trained context_length (UINT32)', () => {
    const buf = buildGguf([
      kvString('general.architecture', 'llama'),
      kvU32('llama.context_length', 131072)
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'llama', contextLength: 131072 })
  })

  it('reads a UINT64 context_length (qwen-style)', () => {
    const buf = buildGguf([
      kvString('general.architecture', 'qwen3moe'),
      kvU64('qwen3moe.context_length', 262144)
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'qwen3moe', contextLength: 262144 })
  })

  it('short-circuits before the tokenizer array — never walks the huge token list', () => {
    // The oversized array sits AFTER the two keys. If the parser did not stop early it would try to
    // read 1,000,000 strings, run off the buffer, and return {} — so a correct result proves it stopped.
    const buf = buildGguf([
      kvString('general.architecture', 'llama'),
      kvU32('llama.context_length', 32768),
      kvOversizedStringArray('tokenizer.ggml.tokens')
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'llama', contextLength: 32768 })
  })

  it('resolves even when context_length precedes general.architecture', () => {
    const buf = buildGguf([
      kvU32('llama.context_length', 4096),
      kvString('general.architecture', 'llama')
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'llama', contextLength: 4096 })
  })

  it('returns the architecture but no contextLength when the key is absent', () => {
    const buf = buildGguf([
      kvString('general.architecture', 'llama'),
      kvU32('llama.embedding_length', 4096)
    ])
    expect(parseGgufMetadata(buf)).toEqual({ architecture: 'llama' })
  })

  it('returns {} for a non-GGUF buffer', () => {
    expect(parseGgufMetadata(Buffer.from('not a gguf file at all'))).toEqual({})
  })

  it('returns {} for an unsupported (v1) file', () => {
    expect(parseGgufMetadata(buildGguf([kvString('general.architecture', 'llama')], 1))).toEqual({})
  })
})

describe('readGgufContextLength (real temp file, real fs)', () => {
  it('reads the trained context length off a real file on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-meta-'))
    const p = path.join(dir, 'model.gguf')
    try {
      fs.writeFileSync(
        p,
        buildGguf([
          kvString('general.architecture', 'llama'),
          kvU32('llama.context_length', 131072),
          kvOversizedStringArray('tokenizer.ggml.tokens')
        ])
      )
      expect(readGgufContextLength(p, fs)).toBe(131072)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null for a missing / unreadable file', () => {
    expect(readGgufContextLength('/no/such/model.gguf', fs)).toBeNull()
  })

  it('returns null when the key sits past the bytes we read (prefix bound honored)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-meta-'))
    const p = path.join(dir, 'model.gguf')
    try {
      fs.writeFileSync(
        p,
        buildGguf([
          kvString('general.architecture', 'llama'),
          kvU32('llama.context_length', 131072)
        ])
      )
      // Read only the first 8 bytes — the KV block is beyond that, so ctx can't be recovered.
      expect(readGgufContextLength(p, fs, 8)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exposes a multi-MB default prefix (cheap vs a multi-GB model, ample for the arch block)', () => {
    expect(GGUF_METADATA_PREFIX_BYTES).toBeGreaterThanOrEqual(1024 * 1024)
  })
})

describe('tool-calling detection from the chat template', () => {
  it('extracts the chat template, and returns null when it sits past the read window', () => {
    const template = '{% for m in messages %}{{ m.content }}{% endfor %}'
    const found = buildGguf([
      kvString('general.architecture', 'qwen3'),
      kvString('tokenizer.chat_template', template)
    ])
    expect(parseGgufChatTemplate(found)).toBe(template)
    // A token array so large the walk runs off the buffer → null, never a crash.
    const truncated = buildGguf([
      kvOversizedStringArray('tokenizer.ggml.tokens'),
      kvString('tokenizer.chat_template', template)
    ])
    expect(parseGgufChatTemplate(truncated)).toBeNull()
  })

  it('reads tools from templates that wire up tool calling, and not from plain ones', () => {
    const toolTemplate =
      '{% if tools %}{% for t in tools %}{{ t.function.name }}{% endfor %}{% endif %}' +
      '{% if message.tool_calls %}<tool_call>{% endif %}'
    const plainTemplate = '{% for m in messages %}{{ m.role }}: {{ m.content }}{% endfor %}'
    expect(chatTemplateDeclaresTools(toolTemplate)).toBe(true)
    expect(chatTemplateDeclaresTools(plainTemplate)).toBe(false)
  })
})

describe('readGgufTemplateTraits (real temp file, real fs)', () => {
  const withFile = async (bytes: Buffer, run: (p: string) => Promise<void>): Promise<void> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-traits-'))
    const p = path.join(dir, 'model.gguf')
    try {
      fs.writeFileSync(p, bytes)
      await run(p)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('reads tool calling and a thinking control off the template on disk', async () => {
    const template =
      '{% if enable_thinking %}<think>{% endif %}{% for t in tools %}{{ t.name }}{% endfor %}'
    await withFile(buildGguf([kvString('tokenizer.chat_template', template)]), async (p) => {
      expect(await readGgufTemplateTraits(p)).toEqual({ tools: true, reasoning: true })
    })
  })

  it('reports neither trait for a plain chat template', async () => {
    const template = '{% for m in messages %}{{ m.role }}: {{ m.content }}{% endfor %}'
    await withFile(buildGguf([kvString('tokenizer.chat_template', template)]), async (p) => {
      expect(await readGgufTemplateTraits(p)).toEqual({ tools: false, reasoning: false })
    })
  })

  it('is unknown (null), not false, when there is no template or no file', async () => {
    await withFile(buildGguf([kvString('general.architecture', 'llama')]), async (p) => {
      expect(await readGgufTemplateTraits(p)).toBeNull()
    })
    expect(await readGgufTemplateTraits(path.join(os.tmpdir(), 'no-such-model.gguf'))).toBeNull()
  })

  it('reads a new file version again instead of serving the cached answer', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-traits-'))
    const p = path.join(dir, 'model.gguf')
    try {
      fs.writeFileSync(p, buildGguf([kvString('tokenizer.chat_template', '{{ m.content }}')]))
      expect(await readGgufTemplateTraits(p)).toEqual({ tools: false, reasoning: false })
      fs.writeFileSync(
        p,
        buildGguf([kvString('tokenizer.chat_template', '{% for t in tools %}{% endfor %}x')])
      )
      fs.utimesSync(p, new Date(), new Date(Date.now() + 5_000))
      expect(await readGgufTemplateTraits(p)).toEqual({ tools: true, reasoning: false })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
