import { create } from 'zustand'
import { wsManager } from '../api/websocket'
import { sessionsApi } from '../api/sessions'
import { useTeamStore } from './teamStore'
import { useSessionStore } from './sessionStore'
import { useCLITaskStore } from './cliTaskStore'
import { randomSpinnerVerb } from '../config/spinnerVerbs'
import type { MessageEntry } from '../types/session'
import type { PermissionMode } from '../types/settings'
import type { AttachmentRef, ChatState, UIAttachment, UIMessage, ServerMessage, TokenUsage } from '../types/chat'

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

type ChatStore = {
  messages: UIMessage[]
  chatState: ChatState
  connectionState: ConnectionState
  streamingText: string
  streamingToolInput: string
  activeToolUseId: string | null
  activeToolName: string | null
  activeThinkingId: string | null
  pendingPermission: {
    requestId: string
    toolName: string
    input: unknown
    description?: string
  } | null
  tokenUsage: TokenUsage
  elapsedSeconds: number
  statusVerb: string
  connectedSessionId: string | null
  slashCommands: Array<{ name: string; description: string }>

  // Actions
  connectToSession: (sessionId: string) => void
  disconnectSession: () => void
  sendMessage: (content: string, attachments?: AttachmentRef[]) => void
  respondToPermission: (requestId: string, allowed: boolean, rule?: string) => void
  setSessionPermissionMode: (mode: PermissionMode) => void
  stopGeneration: () => void
  loadHistory: (sessionId: string) => Promise<void>
  clearMessages: () => void
  handleServerMessage: (msg: ServerMessage) => void
}

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TodoWrite'])

/** Track tool_use IDs for task-related tools, so we can refresh on tool_result */
const pendingTaskToolUseIds = new Set<string>()

let msgCounter = 0
const nextId = () => `msg-${++msgCounter}-${Date.now()}`
let elapsedTimer: ReturnType<typeof setInterval> | null = null

export const useChatStore = create<ChatStore>((set, get) => ({
  messages: [],
  chatState: 'idle',
  connectionState: 'disconnected',
  streamingText: '',
  streamingToolInput: '',
  activeToolUseId: null,
  activeToolName: null,
  activeThinkingId: null,
  pendingPermission: null,
  tokenUsage: { input_tokens: 0, output_tokens: 0 },
  elapsedSeconds: 0,
  statusVerb: '',
  connectedSessionId: null,
  slashCommands: [],

  connectToSession: (sessionId: string) => {
    const current = get().connectedSessionId
    if (current === sessionId) return

    // Disconnect previous
    if (current) wsManager.disconnect()

    set({
      connectedSessionId: sessionId,
      connectionState: 'connecting',
      messages: [],
      chatState: 'idle',
      streamingText: '',
      streamingToolInput: '',
      activeToolUseId: null,
      activeToolName: null,
      activeThinkingId: null,
      pendingPermission: null,
      elapsedSeconds: 0,
      slashCommands: [],
    })

    // Clear all previous handlers before registering new ones
    // This prevents handler accumulation causing message duplication
    wsManager.clearHandlers()
    wsManager.connect(sessionId)
    wsManager.onMessage((msg) => {
      if (msg.type === 'connected') {
        set({ connectionState: 'connected' })
      }
      get().handleServerMessage(msg)
    })

    // Load history and tasks
    get().loadHistory(sessionId)
    useCLITaskStore.getState().fetchSessionTasks(sessionId)
    sessionsApi.getSlashCommands(sessionId)
      .then(({ commands }) => {
        if (get().connectedSessionId === sessionId) {
          set({ slashCommands: commands })
        }
      })
      .catch(() => {
        if (get().connectedSessionId === sessionId) {
          set({ slashCommands: [] })
        }
      })
  },

  disconnectSession: () => {
    wsManager.disconnect()
    if (elapsedTimer) clearInterval(elapsedTimer)
    useCLITaskStore.getState().clearTasks()
    set({ connectedSessionId: null, chatState: 'idle' })
  },

  sendMessage: (content: string, attachments?: AttachmentRef[]) => {
    const userFacingContent = content.trim()
    const uiAttachments: UIAttachment[] | undefined =
      attachments && attachments.length > 0
        ? attachments.map((attachment) => ({
            type: attachment.type,
            name: attachment.name || attachment.path || attachment.mimeType || attachment.type,
            data: attachment.data,
            mimeType: attachment.mimeType,
          }))
        : undefined

    // If all tasks are completed, inline the task summary before the new user message
    const taskStore = useCLITaskStore.getState()
    const allTasksDone = taskStore.tasks.length > 0 && taskStore.tasks.every((t) => t.status === 'completed')

    // Add user message to UI (with optional task summary before it)
    set((s) => {
      const newMessages = [...s.messages]
      if (allTasksDone) {
        newMessages.push({
          id: nextId(),
          type: 'task_summary',
          tasks: taskStore.tasks.map((t) => ({
            id: t.id,
            subject: t.subject,
            status: t.status,
            activeForm: t.activeForm,
          })),
          timestamp: Date.now(),
        })
        // Clear sticky task bar since we inlined the summary
        taskStore.clearTasks()
      }
      newMessages.push({
        id: nextId(),
        type: 'user_text',
        content: userFacingContent,
        attachments: uiAttachments,
        timestamp: Date.now(),
      })
      return {
        messages: newMessages,
        chatState: 'thinking',
        elapsedSeconds: 0,
        streamingText: '',
        statusVerb: randomSpinnerVerb(),
      }
    })

    // Start elapsed timer
    if (elapsedTimer) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => {
      set((s) => ({ elapsedSeconds: s.elapsedSeconds + 1 }))
    }, 1000)

    wsManager.send({ type: 'user_message', content, attachments })
  },

  respondToPermission: (requestId: string, allowed: boolean, rule?: string) => {
    wsManager.send({ type: 'permission_response', requestId, allowed, ...(rule ? { rule } : {}) })
    set({ pendingPermission: null, chatState: allowed ? 'tool_executing' : 'idle' })
  },

  setSessionPermissionMode: (mode) => {
    if (!get().connectedSessionId) return
    wsManager.send({ type: 'set_permission_mode', mode })
  },

  stopGeneration: () => {
    wsManager.send({ type: 'stop_generation' })
    if (elapsedTimer) clearInterval(elapsedTimer)
    set({ chatState: 'idle' })
  },

  loadHistory: async (sessionId: string) => {
    try {
      const { messages } = await sessionsApi.getMessages(sessionId)
      const uiMessages = mapHistoryMessagesToUiMessages(messages)

      set((state) => {
        if (state.connectedSessionId !== sessionId || state.messages.length > 0) {
          return state
        }
        return { ...state, messages: uiMessages }
      })

      // Extract the last TodoWrite input from history so TaskBar shows for V1 sessions
      const lastTodos = extractLastTodoWriteFromHistory(messages)
      if (lastTodos && lastTodos.length > 0) {
        const taskStore = useCLITaskStore.getState()
        // Only set if V2 task fetch didn't already populate tasks
        if (taskStore.tasks.length === 0) {
          taskStore.setTasksFromTodos(lastTodos)
        }
      }

      // For both V1 and V2: if all tasks completed and the user already
      // continued chatting, suppress the sticky TaskBar on page refresh.
      if (hasUserMessagesAfterTaskCompletion(messages)) {
        useCLITaskStore.getState().markCompletedAndDismissed()
      }
    } catch {
      // Session may not have messages yet
    }
  },

  clearMessages: () => set({ messages: [], streamingText: '', chatState: 'idle' }),

  handleServerMessage: (msg: ServerMessage) => {
    switch (msg.type) {
      case 'connected':
        break

      case 'status':
        set({
          chatState: msg.state,
          // Only override statusVerb if the server sends something other than
          // the generic 'Thinking' — otherwise keep the random verb we picked
          // in sendMessage so the user sees fun loading text.
          ...(msg.verb && msg.verb !== 'Thinking' ? { statusVerb: msg.verb } : {}),
          ...(msg.tokens ? { tokenUsage: { ...get().tokenUsage, output_tokens: msg.tokens } } : {}),
          ...(msg.state === 'idle' ? { activeThinkingId: null, statusVerb: '' } : {}),
        })
        if (msg.state === 'idle' && elapsedTimer) {
          clearInterval(elapsedTimer)
          elapsedTimer = null
        }
        break

      case 'content_start': {
        // Flush any accumulated streamingText as assistant_text BEFORE
        // switching to the next block. This preserves intermediate text
        // segments between tool calls (e.g. "项目已经有 node_modules，直接启动").
        const pendingText = get().streamingText.trim()
        if (pendingText) {
          set((s) => ({
            messages: [...s.messages, {
              id: nextId(),
              type: 'assistant_text',
              content: pendingText,
              timestamp: Date.now(),
            }],
            streamingText: '',
          }))
        }

        if (msg.blockType === 'text') {
          set({ streamingText: '', chatState: 'streaming', activeThinkingId: null })
        } else if (msg.blockType === 'tool_use') {
          set({
            activeToolUseId: msg.toolUseId ?? null,
            activeToolName: msg.toolName ?? null,
            streamingToolInput: '',
            chatState: 'tool_executing',
            activeThinkingId: null,
          })
        }
        break
      }

      case 'content_delta':
        if (msg.text !== undefined) {
          set((s) => ({ streamingText: s.streamingText + msg.text }))
        }
        if (msg.toolInput !== undefined) {
          set((s) => ({ streamingToolInput: s.streamingToolInput + msg.toolInput }))
        }
        break

      case 'thinking':
        // Merge consecutive thinking deltas into one message.
        // Also flush any pending streamingText first — otherwise the text
        // becomes invisible because MessageList only renders streamingText
        // when chatState === 'streaming', and we're about to set it to 'thinking'.
        set((s) => {
          const pendingText = s.streamingText.trim()
          const base = pendingText
            ? [...s.messages, { id: nextId(), type: 'assistant_text' as const, content: pendingText, timestamp: Date.now() }]
            : s.messages

          const last = base[base.length - 1]
          if (last && last.type === 'thinking') {
            // Append to existing thinking message
            const updated = [...base]
            updated[updated.length - 1] = { ...last, content: last.content + msg.text }
            return { messages: updated, chatState: 'thinking', activeThinkingId: last.id, streamingText: '' }
          }
          const id = nextId()
          // Create new thinking message
          return {
            messages: [...base, { id, type: 'thinking', content: msg.text, timestamp: Date.now() }],
            chatState: 'thinking',
            activeThinkingId: id,
            streamingText: '',
          }
        })
        break

      case 'tool_use_complete': {
        const toolName = msg.toolName || get().activeToolName || 'unknown'
        set((s) => ({
          messages: [...s.messages, {
            id: nextId(),
            type: 'tool_use',
            toolName,
            toolUseId: msg.toolUseId || s.activeToolUseId || '',
            input: msg.input,
            timestamp: Date.now(),
            parentToolUseId: msg.parentToolUseId,
          }],
          activeToolUseId: null,
          activeToolName: null,
          activeThinkingId: null,
          streamingToolInput: '',
        }))
        // TodoWrite: input contains the full todo list — update tasks immediately
        if (toolName === 'TodoWrite' && Array.isArray((msg.input as any)?.todos)) {
          useCLITaskStore.getState().setTasksFromTodos((msg.input as any).todos)
        } else if (TASK_TOOL_NAMES.has(toolName)) {
          // V2 task tools — refresh will happen on tool_result
          // when the tool has actually finished executing and written to disk
          const useId = msg.toolUseId || get().activeToolUseId
          if (useId) pendingTaskToolUseIds.add(useId)
        }
        break
      }

      case 'tool_result':
        set((s) => ({
          messages: [...s.messages, {
            id: nextId(),
            type: 'tool_result',
            toolUseId: msg.toolUseId,
            content: msg.content,
            isError: msg.isError,
            timestamp: Date.now(),
            parentToolUseId: msg.parentToolUseId,
          }],
          chatState: 'thinking',
          activeThinkingId: null,
        }))
        // Refresh tasks after a task tool has finished executing
        if (pendingTaskToolUseIds.has(msg.toolUseId)) {
          pendingTaskToolUseIds.delete(msg.toolUseId)
          useCLITaskStore.getState().refreshTasks()
        }
        break

      case 'permission_request':
        set({
          pendingPermission: {
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            description: msg.description,
          },
          chatState: 'permission_pending',
          activeThinkingId: null,
        })
        set((s) => ({
          messages: [...s.messages, {
            id: nextId(),
            type: 'permission_request',
            requestId: msg.requestId,
            toolName: msg.toolName,
            input: msg.input,
            description: msg.description,
            timestamp: Date.now(),
          }],
        }))
        break

      case 'message_complete': {
        // Flush streaming text as a message
        const text = get().streamingText
        if (text) {
          set((s) => ({
            messages: [...s.messages, { id: nextId(), type: 'assistant_text', content: text, timestamp: Date.now() }],
            streamingText: '',
          }))
        }
        set({ tokenUsage: msg.usage, chatState: 'idle', activeThinkingId: null })
        if (elapsedTimer) {
          clearInterval(elapsedTimer)
          elapsedTimer = null
        }
        break
      }

      case 'error':
        set((s) => ({
          messages: [...s.messages, { id: nextId(), type: 'error', message: msg.message, code: msg.code, timestamp: Date.now() }],
          chatState: 'idle',
          activeThinkingId: null,
        }))
        if (elapsedTimer) {
          clearInterval(elapsedTimer)
          elapsedTimer = null
        }
        break

      case 'team_created':
        useTeamStore.getState().handleTeamCreated(msg.teamName)
        break

      case 'team_update':
        useTeamStore.getState().handleTeamUpdate(msg.teamName, msg.members)
        break

      case 'team_deleted':
        useTeamStore.getState().handleTeamDeleted(msg.teamName)
        break

      case 'task_update':
        break

      case 'session_title_updated':
        useSessionStore.getState().updateSessionTitle(msg.sessionId, msg.title)
        break

      case 'system_notification':
        // Cache slash commands from CLI init
        if (msg.subtype === 'slash_commands' && Array.isArray(msg.data)) {
          set({ slashCommands: msg.data as Array<{ name: string; description: string }> })
        }
        break

      case 'pong':
        break
    }
  },
}))

type AssistantHistoryBlock = {
  type: string
  text?: string
  thinking?: string
  name?: string
  id?: string
  input?: unknown
}

type UserHistoryBlock = {
  type: string
  text?: string
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { data?: string }
  mimeType?: string
  media_type?: string
  name?: string
}

export function mapHistoryMessagesToUiMessages(messages: MessageEntry[]): UIMessage[] {
  const uiMessages: UIMessage[] = []

  for (const msg of messages) {
    const timestamp = new Date(msg.timestamp).getTime()

    if (msg.type === 'user' && typeof msg.content === 'string') {
      uiMessages.push({
        id: msg.id || nextId(),
        type: 'user_text',
        content: msg.content,
        timestamp,
      })
      continue
    }

    if (msg.type === 'assistant' && typeof msg.content === 'string') {
      uiMessages.push({
        id: msg.id || nextId(),
        type: 'assistant_text',
        content: msg.content,
        timestamp,
        model: msg.model,
      })
      continue
    }

    // Server marks assistant messages containing tool_use blocks as type 'tool_use',
    // but the content array structure is the same as 'assistant' — handle both.
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      for (const block of msg.content as AssistantHistoryBlock[]) {
        if (block.type === 'thinking' && block.thinking) {
          uiMessages.push({
            id: nextId(),
            type: 'thinking',
            content: block.thinking,
            timestamp,
          })
        } else if (block.type === 'text' && block.text) {
          uiMessages.push({
            id: nextId(),
            type: 'assistant_text',
            content: block.text,
            timestamp,
            model: msg.model,
          })
        } else if (block.type === 'tool_use') {
          uiMessages.push({
            id: nextId(),
            type: 'tool_use',
            toolName: block.name ?? 'unknown',
            toolUseId: block.id ?? '',
            input: block.input,
            timestamp,
            parentToolUseId: msg.parentToolUseId,
          })
        }
      }
      continue
    }

    // Server marks user messages containing tool_result blocks as type 'tool_result',
    // but the content array structure is the same as 'user' — handle both.
    if ((msg.type === 'user' || msg.type === 'tool_result') && Array.isArray(msg.content)) {
      const textParts: string[] = []
      const attachments: UIAttachment[] = []

      for (const block of msg.content as UserHistoryBlock[]) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'image') {
          attachments.push({
            type: 'image',
            name: block.name || 'image',
            data: block.source?.data,
            mimeType: block.mimeType || block.media_type,
          })
        } else if (block.type === 'file') {
          attachments.push({
            type: 'file',
            name: block.name || 'file',
          })
        } else if (block.type === 'tool_result') {
          uiMessages.push({
            id: nextId(),
            type: 'tool_result',
            toolUseId: block.tool_use_id ?? '',
            content: block.content,
            isError: !!block.is_error,
            timestamp,
            parentToolUseId: msg.parentToolUseId,
          })
        }
      }

      if (textParts.length > 0 || attachments.length > 0) {
        uiMessages.push({
          id: nextId(),
          type: 'user_text',
          content: textParts.join('\n'),
          attachments: attachments.length > 0 ? attachments : undefined,
          timestamp,
        })
      }
    }
  }

  return uiMessages
}

/** Scan history messages for the last TodoWrite tool_use and return the todos array.
 *  Returns null if all todos were completed and the user continued chatting after. */
function extractLastTodoWriteFromHistory(
  messages: MessageEntry[],
): Array<{ content: string; status: string; activeForm?: string }> | null {
  let foundIndex = -1
  let todos: Array<{ content: string; status: string; activeForm?: string }> | null = null

  // Walk backwards to find the most recent TodoWrite
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      const blocks = msg.content as AssistantHistoryBlock[]
      for (let j = blocks.length - 1; j >= 0; j--) {
        const block = blocks[j]!
        if (block.type === 'tool_use' && block.name === 'TodoWrite') {
          const input = block.input as { todos?: unknown } | undefined
          if (input && Array.isArray(input.todos)) {
            todos = input.todos as Array<{ content: string; status: string; activeForm?: string }>
            foundIndex = i
            break
          }
        }
      }
      if (todos) break
    }
  }

  if (!todos) return null

  // If all todos are completed and there are user messages after, the tasks
  // were already inlined — don't re-show the sticky bar.
  const allDone = todos.every((t) => t.status === 'completed')
  if (allDone) {
    for (let i = foundIndex + 1; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.type === 'user' && msg.content) return null
    }
  }

  return todos
}

const TASK_RELATED_TOOL_NAMES = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList'])

/** Check if there are user messages after the last task-related tool call.
 *  Used to determine if completed tasks should be shown as sticky or inline. */
function hasUserMessagesAfterTaskCompletion(messages: MessageEntry[]): boolean {
  // Find the index of the last task-related tool call
  let lastTaskIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if ((msg.type === 'assistant' || msg.type === 'tool_use') && Array.isArray(msg.content)) {
      const blocks = msg.content as AssistantHistoryBlock[]
      if (blocks.some((b) => b.type === 'tool_use' && TASK_RELATED_TOOL_NAMES.has(b.name ?? ''))) {
        lastTaskIndex = i
        break
      }
    }
  }

  if (lastTaskIndex < 0) return false

  // Check for user messages after the last task tool
  for (let i = lastTaskIndex + 1; i < messages.length; i++) {
    if (messages[i]!.type === 'user') return true
  }
  return false
}
