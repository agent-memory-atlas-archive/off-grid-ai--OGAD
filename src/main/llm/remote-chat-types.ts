import type { RemoteVisionProvider } from '../../shared/remote-vision-server'

export interface RemoteTextModelConnection {
  id: string
  name: string
  provider: Exclude<RemoteVisionProvider, 'local'>
  endpoint: string
  model: string
  apiKey: string
  /** Set only by a local runtime after it reports its execution backend. */
  computeBackend?: string
}
