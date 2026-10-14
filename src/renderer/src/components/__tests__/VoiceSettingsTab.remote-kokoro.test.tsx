// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { VoiceSettingsTab } from '../VoiceSettingsTab'

/** The preload boundary for a Mac whose Voice runs on a remote Kokoro model: the remote model
 *  offers the same speaker ids as the local Kokoro runtime. */
function installRemoteKokoroVoice(): void {
  ;(window as unknown as { api: unknown }).api = {
    getActiveModalities: async () => ({
      speech: 'remote-vision:gpu-pod:kokoro-82m-v1.0.onnx'
    }),
    ttsVoices: async () => [
      { id: 'af_heart', label: 'Heart', language: 'en-US', languageLabel: 'English (US)' },
      { id: 'df_anna', label: 'Anna', language: 'de', languageLabel: 'German' },
      { id: 'hf_alpha', label: 'Alpha', language: 'hi', languageLabel: 'Hindi' }
    ],
    getSettings: async () => ({ ttsVoice: 'af_heart' }),
    saveSetting: async () => undefined,
    prepareTtsVoice: async () => ({ ready: true }),
    onTtsVoiceProgress: () => () => {}
  }
}

describe('<VoiceSettingsTab/> with a remote Kokoro speech model', () => {
  afterEach(cleanup)

  it('offers the remote speakers and their languages', async () => {
    installRemoteKokoroVoice()
    render(<VoiceSettingsTab />)

    await screen.findByText('Speaker selected.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      screen.queryByText('Speaker choices are not available for this remote model.')
    ).toBeNull()
    expect(screen.getByText('Language')).toBeTruthy()
    expect(screen.getByText('Heart · English (US) · speaks at 1.0x')).toBeTruthy()
  })
})
