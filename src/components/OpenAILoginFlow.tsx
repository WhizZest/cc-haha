import React, { useCallback, useEffect, useState } from 'react'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { installOpenAIOAuthTokens } from '../cli/handlers/auth.js'
import { Box, Link, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { OpenAIOAuthService } from '../services/openaiAuth/index.js'
import { getOpenAIOAuthTokens } from '../services/openaiAuth/storage.js'
import { logError } from '../utils/log.js'
import { Spinner } from './Spinner.js'

type Props = {
  onDone(): void
  startingMessage?: string
}

type OpenAILoginStatus =
  | { state: 'ready_to_start' }
  | { state: 'waiting_for_login'; url: string }
  | { state: 'success'; warning?: string | null }
  | { state: 'error'; message: string }

export function OpenAILoginFlow({
  onDone,
  startingMessage,
}: Props): React.ReactNode {
  const [oauthService] = useState(() => new OpenAIOAuthService())
  const [status, setStatus] = useState<OpenAILoginStatus>({
    state: 'ready_to_start',
  })

  useKeybinding(
    'confirm:yes',
    () => {
      logEvent('tengu_openai_oauth_success', {})
      onDone()
    },
    {
      context: 'Confirmation',
      isActive: status.state === 'success',
    },
  )

  const startOAuth = useCallback(async () => {
    try {
      logEvent('tengu_openai_oauth_flow_start', {})
      const tokens = await oauthService.startOAuthFlow(async url => {
        setStatus({ state: 'waiting_for_login', url })
      })
      const warning = await installOpenAIOAuthTokens(tokens)
      setStatus({ state: 'success', warning })
    } catch (error) {
      logError(error)
      setStatus({
        state: 'error',
        message: (error as Error).message,
      })
      logEvent('tengu_openai_oauth_error', {
        error: (error as Error)
          .message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  }, [oauthService])

  useEffect(() => {
    if (status.state !== 'ready_to_start') {
      return
    }

    void startOAuth()
  }, [startOAuth, status.state])

  useEffect(() => {
    return () => {
      oauthService.cleanup()
    }
  }, [oauthService])

  const account = getOpenAIOAuthTokens()

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {startingMessage ??
          'Claude Code can also run through your ChatGPT subscription via OpenAI auth.'}
      </Text>

      {status.state === 'waiting_for_login' && (
        <Box flexDirection="column" gap={1}>
          <Box>
            <Spinner />
            <Text>Opening browser to sign in to OpenAI…</Text>
          </Box>
          <Text dimColor>Use the URL below if your browser did not open:</Text>
          <Link url={status.url}>
            <Text dimColor>{status.url}</Text>
          </Link>
        </Box>
      )}

      {status.state === 'success' && (
        <Box flexDirection="column">
          {account?.email ? (
            <Text dimColor>
              Logged in as <Text>{account.email}</Text>
            </Text>
          ) : null}
          {status.warning ? (
            <Text color="warning">{status.warning}</Text>
          ) : null}
          <Text color="success">
            Login successful. Press <Text bold>Enter</Text> to continue…
          </Text>
        </Box>
      )}

      {status.state === 'error' && (
        <Text color="error">OpenAI OAuth error: {status.message}</Text>
      )}
    </Box>
  )
}
