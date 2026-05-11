import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { startServer } from '../index.js'
import { H5AccessService } from '../services/h5AccessService.js'
import { ProviderService } from '../services/providerService.js'

let server: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ''
let wsBaseUrl = ''
let tmpDir = ''
let originalConfigDir: string | undefined
let originalAnthropicApiKey: string | undefined
let originalH5DistDir: string | undefined
let originalClaudeAppRoot: string | undefined
let originalServerAuthRequired: string | undefined
let originalServerPort = 3456

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {}

    await Bun.sleep(50)
  }

  throw new Error(`Timed out waiting for server at ${url}`)
}

function randomPort(): number {
  return 18000 + Math.floor(Math.random() * 10000)
}

async function startRemoteServer(options: { authRequired?: boolean } = {}): Promise<void> {
  if (options.authRequired) {
    process.env.SERVER_AUTH_REQUIRED = '1'
  } else {
    delete process.env.SERVER_AUTH_REQUIRED
  }

  const port = randomPort()
  server = startServer(port, '0.0.0.0')
  baseUrl = `http://127.0.0.1:${port}`
  wsBaseUrl = `ws://127.0.0.1:${port}`
  await waitForServer(`${baseUrl}/health`)
}

async function restartRemoteServer(options: { authRequired?: boolean } = {}): Promise<void> {
  server?.stop(true)
  server = undefined
  await startRemoteServer(options)
}

function makeUpgradeHeaders(origin?: string): HeadersInit {
  return {
    Connection: 'Upgrade',
    Upgrade: 'websocket',
    ...(origin ? { Origin: origin } : {}),
  }
}

async function enableH5Access(options: {
  allowedOrigins?: string[]
} = {}): Promise<string> {
  const service = new H5AccessService()
  if (options.allowedOrigins) {
    await service.updateSettings({ allowedOrigins: options.allowedOrigins })
  }
  const { token } = await service.enable()
  if (options.allowedOrigins) {
    await service.updateSettings({ allowedOrigins: options.allowedOrigins })
  }
  return token
}

function expectWebSocketOpen(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error(`Timed out opening websocket: ${url}`))
    }, 5000)

    ws.addEventListener('open', () => {
      clearTimeout(timeout)
      ws.close()
      resolve()
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error(`WebSocket failed to open: ${url}`))
    })
  })
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'h5-access-auth-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY
  originalH5DistDir = process.env.CLAUDE_H5_DIST_DIR
  originalClaudeAppRoot = process.env.CLAUDE_APP_ROOT
  originalServerAuthRequired = process.env.SERVER_AUTH_REQUIRED
  originalServerPort = ProviderService.getServerPort()
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  const h5DistDir = path.join(tmpDir, 'dist')
  process.env.CLAUDE_H5_DIST_DIR = h5DistDir
  delete process.env.ANTHROPIC_API_KEY
  await fs.mkdir(path.join(h5DistDir, 'assets'), { recursive: true })
  await fs.writeFile(
    path.join(h5DistDir, 'index.html'),
    '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body>H5 Shell</body></html>',
    'utf-8',
  )
  await fs.writeFile(path.join(h5DistDir, 'assets/app.js'), 'window.__h5 = true', 'utf-8')
  await startRemoteServer()
})

afterEach(async () => {
  server?.stop(true)
  server = undefined
  ProviderService.setServerPort(originalServerPort)

  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir

  if (originalAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
  if (originalH5DistDir === undefined) delete process.env.CLAUDE_H5_DIST_DIR
  else process.env.CLAUDE_H5_DIST_DIR = originalH5DistDir
  if (originalClaudeAppRoot === undefined) delete process.env.CLAUDE_APP_ROOT
  else process.env.CLAUDE_APP_ROOT = originalClaudeAppRoot
  if (originalServerAuthRequired === undefined) delete process.env.SERVER_AUTH_REQUIRED
  else process.env.SERVER_AUTH_REQUIRED = originalServerAuthRequired

  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('remote H5 auth and CORS integration', () => {
  test('serves the packaged H5 shell and static assets from the remote server', async () => {
    const shellResponse = await fetch(`${baseUrl}/`)
    expect(shellResponse.status).toBe(200)
    expect(shellResponse.headers.get('Content-Type')).toContain('text/html')
    await expect(shellResponse.text()).resolves.toContain('H5 Shell')

    const assetResponse = await fetch(`${baseUrl}/assets/app.js`)
    expect(assetResponse.status).toBe(200)
    expect(assetResponse.headers.get('Cache-Control')).toContain('immutable')
    await expect(assetResponse.text()).resolves.toContain('window.__h5')
  })

  test('finds Tauri packaged H5 resources under Resources/_up_/dist', async () => {
    const appRoot = path.join(tmpDir, 'Fake.app', 'Contents', 'MacOS')
    const mappedDistDir = path.join(tmpDir, 'Fake.app', 'Contents', 'Resources', '_up_', 'dist')
    delete process.env.CLAUDE_H5_DIST_DIR
    process.env.CLAUDE_APP_ROOT = appRoot

    await fs.mkdir(mappedDistDir, { recursive: true })
    await fs.writeFile(path.join(mappedDistDir, 'index.html'), 'Mapped H5 Shell', 'utf-8')

    const response = await fetch(`${baseUrl}/`)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('Mapped H5 Shell')
  })

  test('allows /api/status by default without H5 token or Anthropic key', async () => {
    const response = await fetch(`${baseUrl}/api/status`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('allows localhost WebUI origin without H5 token for browser development', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: 'http://127.0.0.1:5179',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://127.0.0.1:5179')
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('allows the Tauri desktop WebView origin to control the local sidecar without H5 token', async () => {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: 'http://tauri.localhost',
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://tauri.localhost')
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('keeps /api/status open by default even when a stale bearer token is sent', async () => {
    await enableH5Access()

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: 'Bearer wrong-token',
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('allows /api/status with a bearer token while default auth is open', async () => {
    const token = await enableH5Access()

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
    })
  })

  test('allows arbitrary CORS origins while default H5 access is open', async () => {
    const token = await enableH5Access({
      allowedOrigins: ['https://allowed.example.com'],
    })

    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        ...makeUpgradeHeaders('https://blocked.example.com'),
        Authorization: `Bearer ${token}`,
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://blocked.example.com')
  })

  test('allows same-origin H5 browser requests without a separate origin allowlist entry', async () => {
    const token = await enableH5Access()

    const response = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Origin: baseUrl,
        Authorization: `Bearer ${token}`,
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(baseUrl)
  })

  test('allows configured CORS origins and includes Vary: Origin', async () => {
    const token = await enableH5Access({
      allowedOrigins: ['https://allowed.example.com'],
    })

    const response = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example.com',
        Authorization: `Bearer ${token}`,
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://allowed.example.com',
    )
    expect(response.headers.get('Vary')).toBe('Origin')
  })

  test('opens websocket upgrades without H5 token by default', async () => {
    await expectWebSocketOpen(`${wsBaseUrl}/ws/h5-auth-test`)
  })

  test('honors explicit auth opt-in for REST and websocket requests', async () => {
    await restartRemoteServer({ authRequired: true })
    const token = await enableH5Access()

    const missingStatusResponse = await fetch(`${baseUrl}/api/status`)
    expect(missingStatusResponse.status).toBe(401)

    const wrongStatusResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: 'Bearer wrong-token',
      },
    })
    expect(wrongStatusResponse.status).toBe(401)

    const validStatusResponse = await fetch(`${baseUrl}/api/status`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
    expect(validStatusResponse.status).toBe(200)

    const missingTokenResponse = await fetch(`${baseUrl}/ws/h5-auth-test`, {
      headers: makeUpgradeHeaders(),
    })
    expect(missingTokenResponse.status).toBe(401)

    const wrongTokenResponse = await fetch(`${baseUrl}/ws/h5-auth-test?token=wrong-token`, {
      headers: makeUpgradeHeaders(),
    })
    expect(wrongTokenResponse.status).toBe(401)

    await expectWebSocketOpen(`${wsBaseUrl}/ws/h5-auth-test?token=${token}`)
  })
})
