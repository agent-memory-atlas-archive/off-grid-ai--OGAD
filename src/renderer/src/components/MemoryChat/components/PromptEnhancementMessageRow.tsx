import { memo } from 'react'
import { ChatLoadingCard } from '../../ChatLoadingCard'
import type { ChatMessage } from '../types'

export const PromptEnhancementMessageRow = memo(function PromptEnhancementMessageRow({
  message
}: Readonly<{ message: ChatMessage }>): React.JSX.Element {
  return (
    <div className="mb-5 flex flex-col items-start" data-testid="prompt-enhancement-status">
      <ChatLoadingCard label={message.content.trim()} />
    </div>
  )
})
