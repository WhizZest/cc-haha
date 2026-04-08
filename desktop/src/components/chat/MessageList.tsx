import { useRef, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n/locales/en'
import { UserMessage } from './UserMessage'
import { AssistantMessage } from './AssistantMessage'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolCallGroup } from './ToolCallGroup'
import { ToolResultBlock } from './ToolResultBlock'
import { PermissionDialog } from './PermissionDialog'
import { AskUserQuestion } from './AskUserQuestion'
import { StreamingIndicator } from './StreamingIndicator'
import { InlineTaskSummary } from './InlineTaskSummary'
import type { UIMessage } from '../../types/chat'

type ToolCall = Extract<UIMessage, { type: 'tool_use' }>
type ToolResult = Extract<UIMessage, { type: 'tool_result' }>

type RenderItem =
  | { kind: 'tool_group'; toolCalls: ToolCall[]; id: string }
  | { kind: 'message'; message: UIMessage }

export function buildRenderItems(messages: UIMessage[], toolUseIds: Set<string>): RenderItem[] {
  const items: RenderItem[] = []
  let pendingToolCalls: ToolCall[] = []

  const flushGroup = () => {
    if (pendingToolCalls.length > 0) {
      items.push({
        kind: 'tool_group',
        toolCalls: [...pendingToolCalls],
        id: `group-${pendingToolCalls[0]!.id}`,
      })
      pendingToolCalls = []
    }
  }

  for (const msg of messages) {
    if (msg.type === 'tool_result' && toolUseIds.has(msg.toolUseId)) {
      continue
    }

    if (msg.type === 'tool_use') {
      if (msg.parentToolUseId) {
        flushGroup()
        continue
      }
      if (msg.toolName === 'AskUserQuestion') {
        flushGroup()
        items.push({ kind: 'message', message: msg })
      } else {
        pendingToolCalls.push(msg)
      }
    } else {
      flushGroup()
      items.push({ kind: 'message', message: msg })
    }
  }

  flushGroup()
  return items
}

export function MessageList() {
  const { messages, chatState, streamingText, activeThinkingId } = useChatStore()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' })
  }, [messages.length, streamingText])

  const toolUseIds = new Set<string>()
  const toolResultMap = new Map<string, ToolResult>()
  const childToolCallsByParent = new Map<string, ToolCall[]>()

  for (const msg of messages) {
    if (msg.type === 'tool_use') {
      toolUseIds.add(msg.toolUseId)
      if (msg.parentToolUseId) {
        const siblings = childToolCallsByParent.get(msg.parentToolUseId)
        if (siblings) {
          siblings.push(msg)
        } else {
          childToolCallsByParent.set(msg.parentToolUseId, [msg])
        }
      }
    }
    if (msg.type === 'tool_result' && msg.toolUseId) {
      toolResultMap.set(msg.toolUseId, msg)
    }
  }

  const renderItems = buildRenderItems(messages, toolUseIds)

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto max-w-[860px]">
        {renderItems.map((item) => {
          if (item.kind === 'tool_group') {
            return (
              <ToolCallGroup
                key={item.id}
                toolCalls={item.toolCalls}
                resultMap={toolResultMap}
                childToolCallsByParent={childToolCallsByParent}
                isStreaming={
                  chatState === 'tool_executing' &&
                  item.toolCalls.some((tc) => !toolResultMap.has(tc.toolUseId))
                }
              />
            )
          }

          const msg = item.message
          return (
            <MessageBlock
              key={msg.id}
              message={msg}
              activeThinkingId={activeThinkingId}
              toolResult={
                msg.type === 'tool_use'
                  ? (() => {
                      const r = toolResultMap.get(msg.toolUseId)
                      return r ? { content: r.content, isError: r.isError } : null
                    })()
                  : null
              }
            />
          )
        })}

        {streamingText && chatState === 'streaming' && (
          <AssistantMessage content={streamingText} isStreaming />
        )}

        {/* Show StreamingIndicator when:
            - tool_executing: tool is running
            - thinking but no active ThinkingBlock yet: the gap between
              sending a message and receiving the first thinking delta */}
        {(chatState === 'tool_executing' || (chatState === 'thinking' && !activeThinkingId)) && (
          <StreamingIndicator />
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function MessageBlock({
  message,
  activeThinkingId,
  toolResult,
}: {
  message: UIMessage
  activeThinkingId: string | null
  toolResult?: { content: unknown; isError: boolean } | null
}) {
  const t = useTranslation()

  switch (message.type) {
    case 'user_text':
      return <UserMessage content={message.content} attachments={message.attachments} />
    case 'assistant_text':
      return <AssistantMessage content={message.content} />
    case 'thinking':
      return <ThinkingBlock content={message.content} isActive={message.id === activeThinkingId} />
    case 'tool_use':
      if (message.toolName === 'AskUserQuestion') {
        return (
          <AskUserQuestion
            toolUseId={message.toolUseId}
            input={message.input}
          />
        )
      }
      return (
        <ToolCallBlock
          toolName={message.toolName}
          input={message.input}
          result={toolResult}
        />
      )
    case 'tool_result':
      return (
        <ToolResultBlock
          content={message.content}
          isError={message.isError}
          standalone
        />
      )
    case 'permission_request':
      return (
        <PermissionDialog
          requestId={message.requestId}
          toolName={message.toolName}
          input={message.input}
          description={message.description}
        />
      )
    case 'error': {
      const errorKey = message.code ? `error.${message.code}` as TranslationKey : null
      const errorText = errorKey ? t(errorKey) : null
      const displayMessage = (errorText && errorText !== errorKey) ? errorText : message.message
      return (
        <div className="mb-3 px-4 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-[var(--color-error)]">
          <strong>Error:</strong> {displayMessage}
        </div>
      )
    }
    case 'task_summary':
      return <InlineTaskSummary tasks={message.tasks} />
    case 'system':
      return (
        <div className="mb-3 text-center text-xs text-[var(--color-text-tertiary)]">
          {message.content}
        </div>
      )
  }
}
