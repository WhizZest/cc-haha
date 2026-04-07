/**
 * WebSocket connection handler
 *
 * 管理 WebSocket 连接生命周期，处理消息路由。
 * 用户消息通过 CLI 子进程（stream-json 模式）处理，
 * CLI stdout 消息被转换为 ServerMessage 并转发到 WebSocket。
 */

import type { ServerWebSocket } from 'bun'
import type { ClientMessage, ServerMessage } from './events.js'
import {
  ConversationStartupError,
  conversationService,
} from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { SettingsService } from '../services/settingsService.js'
import { ProviderService } from '../services/providerService.js'

const settingsService = new SettingsService()
const providerService = new ProviderService()

/**
 * Cache slash commands from CLI init messages, keyed by sessionId.
 */
const sessionSlashCommands = new Map<string, Array<{ name: string; description: string }>>()

export function getSlashCommands(sessionId: string): Array<{ name: string; description: string }> {
  return sessionSlashCommands.get(sessionId) || []
}

export type WebSocketData = {
  sessionId: string
  connectedAt: number
  channel: 'client' | 'sdk'
  sdkToken: string | null
  serverPort: number
  serverHost: string
}

// Active WebSocket sessions
const activeSessions = new Map<string, ServerWebSocket<WebSocketData>>()

export const handleWebSocket = {
  open(ws: ServerWebSocket<WebSocketData>) {
    const { sessionId, channel, sdkToken } = ws.data

    if (channel === 'sdk') {
      if (!conversationService.authorizeSdkConnection(sessionId, sdkToken)) {
        console.warn(`[WS] Rejected SDK connection for session: ${sessionId}`)
        ws.close(1008, 'Invalid SDK token')
        return
      }

      conversationService.attachSdkConnection(sessionId, ws)
      console.log(`[WS] SDK connected for session: ${sessionId}`)
      return
    }

    console.log(`[WS] Client connected for session: ${sessionId}`)

    activeSessions.set(sessionId, ws)

    const msg: ServerMessage = { type: 'connected', sessionId }
    ws.send(JSON.stringify(msg))
  },

  message(ws: ServerWebSocket<WebSocketData>, rawMessage: string | Buffer) {
    if (ws.data.channel === 'sdk') {
      const payload = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      conversationService.handleSdkPayload(ws.data.sessionId, payload)
      return
    }

    try {
      const message = JSON.parse(
        typeof rawMessage === 'string' ? rawMessage : rawMessage.toString()
      ) as ClientMessage

      switch (message.type) {
        case 'user_message':
          handleUserMessage(ws, message).catch((err) => {
            console.error(`[WS] Unhandled error in handleUserMessage:`, err)
          })
          break

        case 'permission_response':
          handlePermissionResponse(ws, message)
          break

        case 'set_permission_mode':
          handleSetPermissionMode(ws, message)
          break

        case 'stop_generation':
          handleStopGeneration(ws)
          break

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' } satisfies ServerMessage))
          break

        default:
          sendError(ws, `Unknown message type: ${(message as any).type}`, 'UNKNOWN_TYPE')
      }
    } catch (error) {
      sendError(ws, `Invalid message format: ${error}`, 'PARSE_ERROR')
    }
  },

  close(ws: ServerWebSocket<WebSocketData>, code: number, reason: string) {
    const { sessionId, channel } = ws.data

    if (channel === 'sdk') {
      console.log(`[WS] SDK disconnected from session: ${sessionId} (${code}: ${reason})`)
      conversationService.detachSdkConnection(sessionId)
      return
    }

    console.log(`[WS] Client disconnected from session: ${sessionId} (${code}: ${reason})`)
    activeSessions.delete(sessionId)
    cleanupStreamState(sessionId)
    sessionSlashCommands.delete(sessionId)

    // NOTE: Do NOT stop CLI subprocess on WS disconnect.
    // The CLI process should stay alive so reconnecting reuses it.
    // This prevents "Session ID already in use" errors from stale locks.
  },

  drain(ws: ServerWebSocket<WebSocketData>) {
    // Backpressure handling - called when the socket is ready to receive more data
  },
}

// ============================================================================
// Message handlers
// ============================================================================

async function handleUserMessage(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'user_message' }>
) {
  const { sessionId } = ws.data
  let workDir = process.cwd()

  // Send thinking status
  sendMessage(ws, { type: 'status', state: 'thinking', verb: 'Thinking' })

  // 启动 CLI 子进程（如果还没有）
  if (!conversationService.hasSession(sessionId)) {
    try {
      // Resolve the session's actual working directory
      try {
        const resolved = await sessionService.getSessionWorkDir(sessionId)
        if (resolved) workDir = resolved
      } catch {
        // fallback to cwd if session file not found
      }
      const runtimeSettings = await getRuntimeSettings()
      const sdkUrl =
        `ws://${ws.data.serverHost}:${ws.data.serverPort}/sdk/${sessionId}` +
        `?token=${encodeURIComponent(crypto.randomUUID())}`
      await conversationService.startSession(sessionId, workDir, sdkUrl, runtimeSettings)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const code =
        err instanceof ConversationStartupError ? err.code : 'CLI_START_FAILED'
      console.error(`[WS] CLI start failed for ${sessionId}: ${errMsg}`)
      sendMessage(ws, {
        type: 'error',
        message: errMsg,
        code,
        retryable:
          err instanceof ConversationStartupError ? err.retryable : false,
      })
      sendMessage(ws, { type: 'status', state: 'idle' })
      return
    }
  }

  // (Re-)register output callback — WS object may have changed on reconnect.
  // Clear old callbacks and set the current one for this WS connection.
  conversationService.clearOutputCallbacks(sessionId)
  conversationService.onOutput(sessionId, (cliMsg) => {
    const serverMsgs = translateCliMessage(cliMsg, sessionId)
    for (const msg of serverMsgs) {
      sendMessage(ws, msg)
    }
  })

  // 将用户消息写入 CLI stdin
  const sent = await conversationService.sendMessage(
    sessionId,
    message.content,
    message.attachments
  )
  if (!sent) {
    sendMessage(ws, {
      type: 'error',
      message: 'CLI process is not running. The session may have ended or the process crashed.',
      code: 'CLI_NOT_RUNNING',
    })
    sendMessage(ws, { type: 'status', state: 'idle' })
  }
}

function handlePermissionResponse(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'permission_response' }>
) {
  const { sessionId } = ws.data
  conversationService.respondToPermission(
    sessionId,
    message.requestId,
    message.allowed,
    message.rule,
  )
  console.log(`[WS] Permission response for ${message.requestId}: ${message.allowed}`)
}

function handleSetPermissionMode(
  ws: ServerWebSocket<WebSocketData>,
  message: Extract<ClientMessage, { type: 'set_permission_mode' }>
) {
  const { sessionId } = ws.data
  const ok = conversationService.setPermissionMode(sessionId, message.mode)
  if (!ok) {
    console.warn(`[WS] Ignored permission mode update for inactive session ${sessionId}`)
  }
}

function handleStopGeneration(ws: ServerWebSocket<WebSocketData>) {
  const { sessionId } = ws.data
  console.log(`[WS] Stop generation requested for session: ${sessionId}`)

  // 向 CLI 子进程发送中断信号
  if (conversationService.hasSession(sessionId)) {
    conversationService.sendInterrupt(sessionId)
  }

  sendMessage(ws, { type: 'status', state: 'idle' })
}

// ============================================================================
// CLI message translation
// ============================================================================

/**
 * Per-session streaming state to avoid cross-session interference.
 * Each session tracks its own dedup flag, active block types, and tool blocks.
 */
type SessionStreamState = {
  hasReceivedStreamEvents: boolean
  activeBlockTypes: Map<number, 'text' | 'tool_use'>
  activeToolBlocks: Map<number, { toolName: string; toolUseId: string; inputJson: string }>
}

const sessionStreamStates = new Map<string, SessionStreamState>()

function getStreamState(sessionId: string): SessionStreamState {
  let state = sessionStreamStates.get(sessionId)
  if (!state) {
    state = {
      hasReceivedStreamEvents: false,
      activeBlockTypes: new Map(),
      activeToolBlocks: new Map(),
    }
    sessionStreamStates.set(sessionId, state)
  }
  return state
}

/** Clean up stream state when session disconnects */
function cleanupStreamState(sessionId: string) {
  sessionStreamStates.delete(sessionId)
}

function translateCliMessage(cliMsg: any, sessionId: string): ServerMessage[] {
  const streamState = getStreamState(sessionId)
  switch (cliMsg.type) {
    case 'assistant': {
      if (cliMsg.error) {
        return [{
          type: 'error',
          message: cliMsg.message?.content?.[0]?.text || cliMsg.error,
          code: cliMsg.error,
        }]
      }

      // If we already received stream_events, text/thinking were already sent.
      // Only extract tool_use blocks (stream_event's content_block_stop lacks complete tool info).
      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        const messages: ServerMessage[] = []

        for (const block of cliMsg.message.content) {
          if (streamState.hasReceivedStreamEvents) {
            // Everything was already sent via stream_event — skip all blocks
          } else {
            // No stream events received — this is the only source, process everything
            if (block.type === 'thinking' && block.thinking) {
              messages.push({ type: 'thinking', text: block.thinking })
            } else if (block.type === 'text' && block.text) {
              messages.push({ type: 'content_start', blockType: 'text' })
              messages.push({ type: 'content_delta', text: block.text })
            } else if (block.type === 'tool_use') {
              messages.push({
                type: 'tool_use_complete',
                toolName: block.name,
                toolUseId: block.id,
                input: block.input,
              })
            }
          }
        }

        // Reset flag for next turn
        streamState.hasReceivedStreamEvents = false
        return messages
      }
      return []
    }

    case 'user': {
      // Bug #1: 处理 tool_result 消息
      // CLI 发送 type:'user' 消息，其中 content 包含 tool_result 块
      const messages: ServerMessage[] = []

      if (cliMsg.message?.content && Array.isArray(cliMsg.message.content)) {
        for (const block of cliMsg.message.content) {
          if (block.type === 'tool_result') {
            messages.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              content: block.content,
              isError: !!block.is_error,
            })
          }
        }
      }

      return messages
    }

    case 'stream_event': {
      streamState.hasReceivedStreamEvents = true
      const event = cliMsg.event
      if (!event) return []

      switch (event.type) {
        case 'message_start': {
          return [{ type: 'status', state: 'streaming' }]
        }

        case 'content_block_start': {
          const contentBlock = event.content_block
          if (!contentBlock) return []

          const index = event.index ?? 0
          streamState.activeBlockTypes.set(index, contentBlock.type === 'tool_use' ? 'tool_use' : 'text')

          if (contentBlock.type === 'tool_use') {
            // Track tool info so content_block_stop can emit complete data
            streamState.activeToolBlocks.set(index, {
              toolName: contentBlock.name || '',
              toolUseId: contentBlock.id || '',
              inputJson: '',
            })
            return [{
              type: 'content_start',
              blockType: 'tool_use',
              toolName: contentBlock.name,
              toolUseId: contentBlock.id,
            }]
          }
          return [{ type: 'content_start', blockType: 'text' }]
        }

        case 'content_block_delta': {
          const delta = event.delta
          if (!delta) return []

          if (delta.type === 'text_delta' && delta.text) {
            return [{ type: 'content_delta', text: delta.text }]
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            // Accumulate tool input JSON
            const index = event.index ?? 0
            const toolBlock = streamState.activeToolBlocks.get(index)
            if (toolBlock) toolBlock.inputJson += delta.partial_json
            return [{ type: 'content_delta', toolInput: delta.partial_json }]
          }
          if (delta.type === 'thinking_delta' && delta.thinking) {
            return [{ type: 'thinking', text: delta.thinking }]
          }
          return []
        }

        case 'content_block_stop': {
          const index = event.index ?? 0
          const blockType = streamState.activeBlockTypes.get(index)
          streamState.activeBlockTypes.delete(index)

          if (blockType === 'tool_use') {
            const toolBlock = streamState.activeToolBlocks.get(index)
            streamState.activeToolBlocks.delete(index)
            if (toolBlock) {
              let parsedInput = null
              try { parsedInput = JSON.parse(toolBlock.inputJson) } catch {}
              return [{
                type: 'tool_use_complete',
                toolName: toolBlock.toolName,
                toolUseId: toolBlock.toolUseId,
                input: parsedInput,
              }]
            }
          }
          return []
        }

        case 'message_stop': {
          // message_stop is handled by the 'result' message
          return []
        }

        case 'message_delta': {
          // message_delta may contain stop_reason or usage updates
          return []
        }

        default:
          return []
      }
    }

    case 'control_request': {
      // 权限请求 — CLI 需要用户授权才能执行工具
      if (cliMsg.request?.subtype === 'can_use_tool') {
        return [{
          type: 'permission_request',
          requestId: cliMsg.request_id,
          toolName: cliMsg.request.tool_name || 'Unknown',
          input: cliMsg.request.input || {},
          description: cliMsg.request.description,
        }]
      }
      return []
    }

    case 'control_response':
      return []

    case 'result': {
      // 对话结果（成功或错误）
      const usage = {
        input_tokens: cliMsg.usage?.input_tokens || 0,
        output_tokens: cliMsg.usage?.output_tokens || 0,
      }

      if (cliMsg.is_error) {
        const resultMessage =
          (typeof cliMsg.result === 'string' && cliMsg.result) ||
          (Array.isArray(cliMsg.errors) && cliMsg.errors.length > 0
            ? cliMsg.errors.join('\n')
            : 'Unknown error')
        // 错误和完成消息都发送
        return [
          {
            type: 'error',
            message: resultMessage,
            code: 'CLI_ERROR',
          },
          { type: 'message_complete', usage },
        ]
      }

      return [{ type: 'message_complete', usage }]
    }

    case 'system': {
      // 区分不同的 system 子类型
      const subtype = cliMsg.subtype
      if (subtype === 'init') {
        // CLI 初始化完成 — 缓存 slash commands 并发送模型信息
        // NOTE: Do NOT send status:idle here — the CLI init fires while
        // processing the first user message, and sending idle would reset
        // the frontend's streaming state prematurely.
        if (cliMsg.slash_commands && Array.isArray(cliMsg.slash_commands)) {
          sessionSlashCommands.set(sessionId, cliMsg.slash_commands.map((cmd: any) => ({
            name: typeof cmd === 'string' ? cmd : (cmd.name || cmd.command || ''),
            description: typeof cmd === 'string' ? '' : (cmd.description || ''),
          })))
        }
        const messages: ServerMessage[] = [
          // Send model info as a system notification, not a status change
          { type: 'system_notification', subtype: 'init', message: `Model: ${cliMsg.model || 'unknown'}`, data: { model: cliMsg.model } },
        ]
        // Send slash commands to frontend
        const cmds = sessionSlashCommands.get(sessionId)
        if (cmds && cmds.length > 0) {
          messages.push({
            type: 'system_notification',
            subtype: 'slash_commands',
            data: cmds,
          })
        }
        return messages
      }
      if (subtype === 'hook_started' || subtype === 'hook_response') {
        // Hook 执行中 — 不转发给前端
        return []
      }
      // Bug #7: 处理 task/team system 消息
      if (subtype === 'task_notification') {
        return [{
          type: 'system_notification',
          subtype: 'task_notification',
          message: cliMsg.message || cliMsg.title,
          data: cliMsg,
        }]
      }
      if (subtype === 'task_started') {
        return [{
          type: 'status',
          state: 'tool_executing',
          verb: cliMsg.message || 'Task started',
        }]
      }
      if (subtype === 'task_progress') {
        return [{
          type: 'status',
          state: 'tool_executing',
          verb: cliMsg.message || 'Task in progress',
        }]
      }
      if (subtype === 'session_state_changed') {
        return [{
          type: 'system_notification',
          subtype: 'session_state_changed',
          message: cliMsg.message,
          data: cliMsg,
        }]
      }
      // 其他 system 消息
      return []
    }

    default:
      // 未知类型 — 调试输出但不转发
      console.log(`[WS] Unknown CLI message type: ${cliMsg.type}`, JSON.stringify(cliMsg).substring(0, 200))
      return []
  }
}

// ============================================================================
// Helpers
// ============================================================================

function sendMessage(ws: ServerWebSocket<WebSocketData>, message: ServerMessage) {
  ws.send(JSON.stringify(message))
}

function sendError(ws: ServerWebSocket<WebSocketData>, message: string, code: string) {
  sendMessage(ws, { type: 'error', message, code })
}

async function getRuntimeSettings(): Promise<{
  permissionMode?: string
  model?: string
  effort?: string
}> {
  const userSettings = await settingsService.getUserSettings()
  const modelContext =
    typeof userSettings.modelContext === 'string' && userSettings.modelContext.trim()
      ? userSettings.modelContext
      : undefined
  const effort =
    typeof userSettings.effort === 'string' && userSettings.effort.trim()
      ? userSettings.effort
      : undefined

  // Check if a custom provider is active
  const { activeId } = await providerService.listProviders()

  let model: string | undefined
  if (activeId) {
    // Provider is active — only pass --model if user explicitly selected a non-default model.
    // Otherwise the CLI should use ANTHROPIC_MODEL from env (set by syncToSettings).
    // Default Anthropic model should be overridden by the provider's model.
    const baseModel = (userSettings.model as string) || ''
    if (baseModel && baseModel !== 'claude-sonnet-4-6-20250514') {
      // User explicitly selected a different model — pass it through
      model = baseModel
      if (modelContext) model += `:${modelContext}`
    }
  } else {
    // No provider — pass model normally
    const baseModel =
      typeof userSettings.model === 'string' && userSettings.model.trim()
        ? userSettings.model
        : undefined
    model = baseModel ? (modelContext ? `${baseModel}:${modelContext}` : baseModel) : undefined
  }

  return {
    permissionMode: await settingsService.getPermissionMode().catch(() => undefined),
    model,
    effort,
  }
}

/**
 * Send a message to a specific session's WebSocket (for use by services)
 */
export function sendToSession(sessionId: string, message: ServerMessage): boolean {
  const ws = activeSessions.get(sessionId)
  if (!ws) return false
  ws.send(JSON.stringify(message))
  return true
}

export function getActiveSessionIds(): string[] {
  return Array.from(activeSessions.keys())
}
