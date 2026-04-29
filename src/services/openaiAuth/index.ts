import { openBrowser } from '../../utils/browser.js'
import { AuthCodeListener } from '../oauth/auth-code-listener.js'
import { generateCodeVerifier, generateState } from '../oauth/crypto.js'
import {
  buildOpenAIAuthorizeUrl,
  exchangeOpenAICodeForTokens,
  isOpenAITokenExpired,
  OPENAI_CODEX_OAUTH_PORT,
  OPENAI_CODEX_REDIRECT_PATH,
  refreshOpenAITokens,
  normalizeOpenAITokens,
  withRefreshedAccessToken,
} from './client.js'
import {
  clearOpenAIOAuthTokenCache,
  deleteOpenAIOAuthTokens,
  getOpenAIOAuthTokensAsync,
  saveOpenAIOAuthTokens,
} from './storage.js'
import type { OpenAIOAuthTokens } from './types.js'

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>cc-haha OpenAI Authorization Successful</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; margin:0; background:#131010; color:#f1ecec; }
      .container { text-align:center; padding:2rem; }
      p { color:#b7b1b1; }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to Claude Code Haha.</p>
    </div>
    <script>setTimeout(() => window.close(), 2000)</script>
  </body>
</html>`

const HTML_ERROR = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>cc-haha OpenAI Authorization Failed</title>
  </head>
  <body>
    <h1>Authorization Failed</h1>
    <p>You can close this window and return to Claude Code Haha.</p>
  </body>
</html>`

export class OpenAIOAuthService {
  private codeVerifier: string
  private authCodeListener: AuthCodeListener | null = null
  private port: number | null = null

  constructor() {
    this.codeVerifier = generateCodeVerifier()
  }

  async startOAuthFlow(
    authURLHandler: (url: string) => Promise<void>,
  ): Promise<OpenAIOAuthTokens> {
    this.authCodeListener = new AuthCodeListener(OPENAI_CODEX_REDIRECT_PATH)
    this.port = await this.authCodeListener.start(OPENAI_CODEX_OAUTH_PORT)

    const state = generateState()
    const redirectUri = `http://localhost:${this.port}${OPENAI_CODEX_REDIRECT_PATH}`
    const authorizeUrl = buildOpenAIAuthorizeUrl({
      redirectUri,
      codeVerifier: this.codeVerifier,
      state,
    })

    const authorizationCode = await new Promise<string>((resolve, reject) => {
      this.authCodeListener
        ?.waitForAuthorization(state, async () => {
          await authURLHandler(authorizeUrl)
          await openBrowser(authorizeUrl)
        })
        .then(resolve)
        .catch(reject)
    })

    try {
      const response = await exchangeOpenAICodeForTokens({
        code: authorizationCode,
        redirectUri,
        codeVerifier: this.codeVerifier,
      })

      const tokens = normalizeOpenAITokens(response)
      const storage = saveOpenAIOAuthTokens(tokens)
      if (!storage.success) {
        throw new Error(storage.warning ?? 'Failed to persist OpenAI OAuth tokens')
      }

      this.authCodeListener?.handleSuccessRedirect([], (res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(HTML_SUCCESS)
      })

      return tokens
    } catch (error) {
      this.authCodeListener?.handleSuccessRedirect([], (res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(HTML_ERROR)
      })
      throw error
    } finally {
      this.cleanup()
    }
  }

  async ensureFreshTokens(): Promise<OpenAIOAuthTokens | null> {
    clearOpenAIOAuthTokenCache()
    const tokens = await getOpenAIOAuthTokensAsync()
    if (!tokens) return null
    if (!isOpenAITokenExpired(tokens.expiresAt)) return tokens

    const refreshed = await refreshOpenAITokens(tokens.refreshToken)
    const updated = withRefreshedAccessToken(tokens, refreshed)
    const storage = saveOpenAIOAuthTokens(updated)
    if (!storage.success) {
      throw new Error(storage.warning ?? 'Failed to persist refreshed OpenAI tokens')
    }

    return updated
  }

  async ensureFreshAccessToken(): Promise<string | null> {
  const tokens = await this.ensureFreshTokens()
  return tokens?.accessToken ?? null
  }

  logout(): boolean {
    clearOpenAIOAuthTokenCache()
    return deleteOpenAIOAuthTokens()
  }

  cleanup(): void {
    this.authCodeListener?.close()
    this.authCodeListener = null
    this.port = null
  }
}

export async function ensureFreshOpenAITokens(): Promise<OpenAIOAuthTokens | null> {
  clearOpenAIOAuthTokenCache()
  const tokens = await getOpenAIOAuthTokensAsync()
  if (!tokens) return null
  if (!isOpenAITokenExpired(tokens.expiresAt)) return tokens

  try {
    const refreshed = await refreshOpenAITokens(tokens.refreshToken)
    const updated = withRefreshedAccessToken(tokens, refreshed)
    const storage = saveOpenAIOAuthTokens(updated)
    if (!storage.success) {
      throw new Error(storage.warning ?? 'Failed to persist refreshed OpenAI tokens')
    }
    return updated
  } catch {
    return null
  }
}
