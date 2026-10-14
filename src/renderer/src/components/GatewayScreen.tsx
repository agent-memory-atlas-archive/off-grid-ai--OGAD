import { useState } from 'react'
import { IconExternalLink, IconServer2 } from '@tabler/icons-react'
import { GATEWAY_HOST, GATEWAY_PORT } from '@offgrid/core/shared/ports'
import { CopyButton } from './ui/CopyButton'
import { GatewayApiKeysSettings } from './GatewayApiKeysSettings'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { PageHeader, Section } from '@offgrid/operator-ui/operator/experience'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@offgrid/operator-ui/operator/coss/input-group'
import { Button } from './ui/button'
import { IconTip } from './IconTip'

// Explains the local OpenAI-compatible gateway with copyable quick-start snippets
// and a link to the interactive playground the gateway serves. Core feature.
const PORT = GATEWAY_PORT
const BASE = `http://${GATEWAY_HOST}:${PORT}`

const ENDPOINTS: { label: string; method: string; path: string; note: string }[] = [
  {
    label: 'Chat (text + vision)',
    method: 'POST',
    path: '/v1/chat/completions',
    note: 'OpenAI-compatible; image_url parts for vision'
  },
  {
    label: 'Text → Image',
    method: 'POST',
    path: '/v1/images',
    note: 'also /v1/images/generations · /edits'
  },
  {
    label: 'Speech → Text (STT)',
    method: 'POST',
    path: '/v1/audio/transcriptions',
    note: 'multipart: file'
  },
  {
    label: 'Text → Speech (TTS)',
    method: 'POST',
    path: '/v1/audio/speech',
    note: '{ input, voice? } → audio/wav'
  },
  {
    label: 'Embeddings',
    method: 'POST',
    path: '/v1/embeddings',
    note: 'local all-MiniLM-L6-v2 · 384-dim'
  },
  { label: 'Models', method: 'GET', path: '/v1/models', note: 'active model per modality' }
]

const SNIPPETS: { id: string; label: string; code: string }[] = [
  {
    id: 'curl',
    label: 'curl',
    code: `curl ${BASE}/v1/chat/completions \\
  -H "Authorization: Bearer $OGAD_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "local",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`
  },
  {
    id: 'python',
    label: 'Python (openai)',
    code: `from openai import OpenAI

client = OpenAI(base_url="${BASE}/v1", api_key="YOUR_API_KEY")
resp = client.chat.completions.create(
    model="local",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`
  },
  {
    id: 'node',
    label: 'JavaScript',
    code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${BASE}/v1", apiKey: "YOUR_API_KEY" });
const resp = await client.chat.completions.create({
  model: "local",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);`
  },
  {
    id: 'image',
    label: 'Image',
    code: `curl ${BASE}/v1/images \\
  -H "Authorization: Bearer $OGAD_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "prompt": "a misty mountain at dawn", "aspect_ratio": "16:9" }' --output out.png`
  }
]

export function GatewayScreen(): React.ReactElement {
  const [tab, setTab] = useState(SNIPPETS[0]!.id)
  const open = (p: string): void => {
    window.open(BASE + p, '_blank')
  }
  const active = SNIPPETS.find((s) => s.id === tab) ?? SNIPPETS[0]!

  return (
    <div className="relative h-full overflow-y-auto font-mono">
      <div className="flex w-full flex-col px-8 pt-8 pb-16">
        <PageHeader
          title="Gateway"
          description="One local, OpenAI-compatible API for every model you download: text, vision, image and voice. It runs on your device, and nothing leaves it."
          actions={
            <IconTip label="Interactive playground">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Interactive playground"
                onClick={() => open('/docs')}
              >
                <IconExternalLink className="h-4 w-4" />
              </Button>
            </IconTip>
          }
        />

        <div className="space-y-12">
          <Section
            label="Base URL"
            description="Point any OpenAI client here. Supply a key when authentication is enabled."
          >
            <InputGroup>
              <InputGroupAddon>
                <IconServer2 aria-hidden="true" />
              </InputGroupAddon>
              <InputGroupInput
                readOnly
                aria-label="Gateway base URL"
                value={`${BASE}/v1`}
                className="font-mono text-emerald-400"
              />
              <InputGroupAddon align="inline-end">
                <CopyButton text={`${BASE}/v1`} />
              </InputGroupAddon>
            </InputGroup>
            <p className="mt-3 text-xs leading-relaxed text-neutral-500">
              Run it headless with <code className="text-neutral-300">--server-only</code> to deploy
              just the gateway.
            </p>
          </Section>

          <Section label="API keys">
            <section aria-label="API keys">
              <GatewayApiKeysSettings />
            </section>
          </Section>

          <Section label="Quick start" actions={<CopyButton text={active.code} />}>
            <Segmented
              label="Quick start language"
              size="sm"
              tone="quiet"
              value={tab}
              onValueChange={setTab}
              options={SNIPPETS.map((s) => ({ id: s.id, label: s.label }))}
            />
            <pre className="mt-3 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-200">
              <code>{active.code}</code>
            </pre>
          </Section>

          <Section label="Endpoints">
            <AnimatedGroup preset="blur-slide" className="grid gap-2 sm:grid-cols-2">
              {ENDPOINTS.map((e) => (
                <button
                  key={e.path}
                  onClick={() => open(e.path)}
                  className="flex h-full w-full flex-col gap-1 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-left transition-colors hover:border-green-500/40"
                >
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                      {e.method}
                    </span>
                    <span className="text-sm text-neutral-200">{e.label}</span>
                  </div>
                  <code className="text-xs text-neutral-500">{e.path}</code>
                  <span className="text-[11px] text-neutral-600">{e.note}</span>
                </button>
              ))}
            </AnimatedGroup>
          </Section>
        </div>
      </div>
    </div>
  )
}
