import { Brain, Eye, PencilSimple, Translate, Wrench } from '@phosphor-icons/react'
import {
  MODEL_CAPABILITIES,
  modelCapabilities,
  type CapabilitySource,
  type ModelCapability
} from '@offgrid/models'

// The glyph for each capability; the shared rule decides which apply and what they are called.
const CAPABILITY_ICONS: Record<ModelCapability, React.ReactElement> = {
  vision: <Eye />,
  tools: <Wrench />,
  reasoning: <Brain />,
  multilingual: <Translate />,
  image_edit: <PencilSimple />
}
const CAPABILITY_LABELS = new Map(MODEL_CAPABILITIES.map(({ id, label }) => [id, label]))

/** What a model can do, as icons with tooltips (no words). Renders nothing when it has none. */
export function ModelCapabilityIcons({
  model
}: {
  model: Omit<CapabilitySource, 'files'> & { files?: readonly { name: string; role?: string }[] }
}): React.ReactNode {
  const capabilities = modelCapabilities(model as CapabilitySource)
  if (capabilities.length === 0) return null
  return capabilities.map((capability) => (
    <span
      key={capability}
      role="img"
      title={CAPABILITY_LABELS.get(capability)}
      aria-label={CAPABILITY_LABELS.get(capability)}
      className="flex text-green-500 [&>svg]:h-3.5 [&>svg]:w-3.5"
    >
      {CAPABILITY_ICONS[capability]}
    </span>
  ))
}
