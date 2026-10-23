// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { MemoryChat } from '../MemoryChat'
import { ChatBoundary, installBoundary } from './harness/chat-boundary'

afterEach(() => cleanup())

// A paired Off Grid gateway as a Mac saves it: its chat model beside its Computer Use specialists,
// one grounder and one decider, which the server lists among its text models.
const pod = {
  id: 'pod',
  name: 'OGAD Remote',
  provider: 'ogad',
  endpoint: 'http://127.0.0.1:17878/v1',
  model: 'qwen3.8-27b',
  enabled: true,
  hasApiKey: false,
  screenFramesAllowed: false,
  mediaModels: { text: 'qwen3.8-27b' },
  roleModels: { grounding: 'bartowski/tencent_UI-Mate-27B-GGUF', decision: 'jaredpalmer/kev-4b' },
  modelCatalog: [
    { id: 'qwen3.8-27b', name: 'Qwen3.8 27B', kind: 'text' },
    {
      id: 'bartowski/tencent_UI-Mate-27B-GGUF',
      name: 'UI-Mate-27B',
      kind: 'text',
      inputModalities: ['text', 'image'],
      outputModalities: ['text']
    },
    {
      id: 'jaredpalmer/kev-4b',
      name: 'Kev 4B',
      kind: 'text',
      inputModalities: ['text'],
      outputModalities: ['decisions']
    },
    { id: 'acme/clicker-7b', name: 'Clicker 7B', kind: 'text', role: 'grounding' }
  ]
}

function renderPane(): void {
  const boundary = new ChatBoundary()
  installBoundary(boundary)
  window.api.getRemoteVisionServer = async () => ({
    provider: 'ogad',
    endpoint: pod.endpoint,
    model: pod.model,
    hasApiKey: false,
    activeServerId: pod.id,
    servers: [pod]
  })
  render(
    <TooltipProvider>
      <MemoryChat paneKey="pane-0" split openTarget={{}} />
    </TooltipProvider>
  )
}

describe('<MemoryChat/> split-view pane models', () => {
  it("offers the server's chat models for a pane, never its grounders or deciders", async () => {
    renderPane()
    const user = userEvent.setup()
    await screen.findByRole('combobox', { name: 'Model for this pane' })
    await user.click(screen.getByRole('button', { name: /^Show model for this pane options$/i }))
    expect(await screen.findByRole('option', { name: /Qwen3\.8 27B · OGAD Remote/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Active model' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /UI-Mate/ })).toBeNull()
    expect(screen.queryByRole('option', { name: /Kev/ })).toBeNull()
    // A role the gateway declared keeps a model out even when its name says nothing.
    expect(screen.queryByRole('option', { name: /Clicker/ })).toBeNull()
  })
})
