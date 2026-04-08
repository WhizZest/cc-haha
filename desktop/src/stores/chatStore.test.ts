import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageEntry } from '../types/session'

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}))

vi.mock('../api/websocket', () => ({
  wsManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    clearHandlers: vi.fn(),
    send: sendMock,
  },
}))

vi.mock('../api/sessions', () => ({
  sessionsApi: {
    getMessages: vi.fn(async () => ({ messages: [] })),
    getSlashCommands: vi.fn(async () => ({ commands: [] })),
  },
}))

vi.mock('./teamStore', () => ({
  useTeamStore: {
    getState: () => ({
      handleTeamCreated: vi.fn(),
      handleTeamUpdate: vi.fn(),
      handleTeamDeleted: vi.fn(),
    }),
  },
}))

import { mapHistoryMessagesToUiMessages, useChatStore } from './chatStore'

const initialState = useChatStore.getState()

describe('chatStore history mapping', () => {
  beforeEach(() => {
    sendMock.mockReset()
    useChatStore.setState({
      ...initialState,
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
      connectedSessionId: null,
      slashCommands: [],
    })
  })

  it('preserves thinking blocks when restoring transcript history', () => {
    const messages: MessageEntry[] = [
      {
        id: 'assistant-1',
        type: 'assistant',
        timestamp: '2026-04-06T00:00:00.000Z',
        model: 'opus',
        parentToolUseId: 'agent-1',
        content: [
          { type: 'thinking', thinking: 'internal reasoning' },
          { type: 'text', text: '目录结构分析' },
          { type: 'tool_use', name: 'Read', id: 'tool-1', input: { file_path: 'src/App.tsx' } },
        ],
      },
      {
        id: 'user-1',
        type: 'user',
        timestamp: '2026-04-06T00:00:01.000Z',
        parentToolUseId: 'agent-1',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', is_error: false },
        ],
      },
    ]

    const mapped = mapHistoryMessagesToUiMessages(messages)

    expect(mapped.map((message) => message.type)).toEqual([
      'thinking',
      'assistant_text',
      'tool_use',
      'tool_result',
    ])
    expect(mapped[2]).toMatchObject({ parentToolUseId: 'agent-1' })
    expect(mapped[3]).toMatchObject({ parentToolUseId: 'agent-1' })
  })

  it('keeps parent tool linkage for live tool events', () => {
    useChatStore.getState().handleServerMessage({
      type: 'tool_use_complete',
      toolName: 'Read',
      toolUseId: 'tool-1',
      input: { file_path: 'src/App.tsx' },
      parentToolUseId: 'agent-1',
    })

    useChatStore.getState().handleServerMessage({
      type: 'tool_result',
      toolUseId: 'tool-1',
      content: 'ok',
      isError: false,
      parentToolUseId: 'agent-1',
    })

    expect(useChatStore.getState().messages).toMatchObject([
      {
        type: 'tool_use',
        toolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        parentToolUseId: 'agent-1',
      },
    ])
  })

  it('sends permission mode updates to the active session only', () => {
    useChatStore.getState().setSessionPermissionMode('acceptEdits')
    expect(sendMock).not.toHaveBeenCalled()

    useChatStore.setState({ connectedSessionId: 'session-1' })
    useChatStore.getState().setSessionPermissionMode('acceptEdits')

    expect(sendMock).toHaveBeenCalledWith({
      type: 'set_permission_mode',
      mode: 'acceptEdits',
    })
  })
})
