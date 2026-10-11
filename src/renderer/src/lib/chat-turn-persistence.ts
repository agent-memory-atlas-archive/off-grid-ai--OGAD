import type { ChatMessage, RagContext } from '../components/MemoryChat/types'
import type { ResponseCutoffContract } from '../../../shared/ipc-contracts'
import { buildAssistantContext, type AssistantTimelineEntry } from './message-persistence'
import { answerVersion } from './chat-versions'
type Ref<T> = { current: T }
export interface TurnPersistence {
  streamConvRef: Ref<Map<string, string>>
  messagesByConvRef: Ref<Record<string, ChatMessage[]>>
  reasoningByStream: Ref<Record<string, string>>
  timelineByStream: Ref<Record<string, AssistantTimelineEntry[]>>
  toolCallsByStream: Ref<Record<string, NonNullable<ChatMessage['toolCalls']>>>
  answerByStream: Ref<Record<string, string>>
  setConvMessages: (cid: string, update: (previous: ChatMessage[]) => ChatMessage[]) => void
  api: Pick<Window['api'], 'updateRagMessage' | 'addRagMessage'>
}
export interface TurnSettlement {
  answer?: string
  context?: RagContext
  persistContext?: Record<string, unknown>
  cutoff?: ResponseCutoffContract
  toolCalls?: ChatMessage['toolCalls']
  toolsOffered?: ChatMessage['toolsOffered']
}

/** Pure projection shared by Stop and terminal streams reattached without a sender. */
export function observedAnswer(
  current: ChatMessage | undefined,
  snapshot: Pick<ChatMessage, 'id' | 'content' | 'reasoning' | 'timeline' | 'toolCalls'>,
  settled: TurnSettlement = {},
  status: ChatMessage['turnStatus'] = 'cancelled'
): ChatMessage {
  const answer: ChatMessage = {
    ...current,
    id: snapshot.id,
    role: 'assistant',
    content: (settled.answer ?? snapshot.content).trim(),
    reasoning: snapshot.reasoning?.trim() || undefined,
    timeline: snapshot.timeline ?? current?.timeline,
    context: settled.context ?? current?.context,
    cutoff: settled.cutoff ?? current?.cutoff,
    toolCalls: settled.toolCalls ?? snapshot.toolCalls ?? current?.toolCalls,
    toolsOffered: settled.toolsOffered ?? current?.toolsOffered,
    turnStatus: status,
    streaming: false,
    activity: undefined
  }
  const variants = current?.variants
    ? [...current.variants.slice(0, -1), answerVersion(answer)]
    : undefined
  const variantIndex = variants ? variants.length - 1 : undefined
  const context = buildAssistantContext(
    {
      ...(settled.persistContext ?? answer.context),
      ...(answer.toolCalls?.length ? { toolCalls: answer.toolCalls } : {}),
      ...(answer.toolsOffered?.length ? { toolsOffered: answer.toolsOffered } : {}),
      status
    },
    {
      reasoning: answer.reasoning,
      timeline: answer.timeline,
      cutoff: answer.cutoff,
      metrics: answer.metrics,
      variants,
      variantIndex
    }
  )
  return { ...answer, variants, variantIndex, context }
}

export async function persistObservedTurn(
  dependencies: TurnPersistence,
  convId: string,
  streamId: string,
  settled?: TurnSettlement,
  status: ChatMessage['turnStatus'] = 'cancelled'
): Promise<void> {
  const d = dependencies
  if (!d.streamConvRef.current.has(streamId)) return
  d.streamConvRef.current.delete(streamId)
  const current = (d.messagesByConvRef.current[convId] ?? []).find(
    (message) => message.id === streamId
  )
  const answer = observedAnswer(
    current,
    {
      id: streamId,
      content: d.answerByStream.current[streamId] ?? '',
      reasoning: d.reasoningByStream.current[streamId],
      timeline: d.timelineByStream.current[streamId],
      toolCalls: d.toolCallsByStream.current[streamId]
    },
    settled,
    status
  )
  delete d.reasoningByStream.current[streamId]
  delete d.timelineByStream.current[streamId]
  delete d.toolCallsByStream.current[streamId]
  delete d.answerByStream.current[streamId]
  d.setConvMessages(convId, (previous) =>
    previous.some((message) => message.id === streamId)
      ? previous.map((message) => (message.id === streamId ? answer : message))
      : [...previous, answer]
  )
  try {
    const savedId = current?.replacementMessageId ?? streamId
    const updated = await d.api.updateRagMessage(convId, savedId, answer.content, answer.context)
    const storedId = updated
      ? savedId
      : (await d.api.addRagMessage(convId, 'assistant', answer.content, answer.context)).uuid
    d.setConvMessages(convId, (previous) =>
      previous.map((message) =>
        message.id === streamId
          ? { ...answer, id: storedId, replacementMessageId: undefined }
          : message
      )
    )
  } catch (error) {
    console.error('Failed to persist observed assistant message:', error)
  }
}
