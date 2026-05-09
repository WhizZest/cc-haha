import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMocks = vi.hoisted(() => ({
  defaultBaseUrl: 'http://127.0.0.1:3456',
  setBaseUrl: vi.fn(),
  setAuthToken: vi.fn(),
  postVerify: vi.fn(),
}))

vi.mock('../api/client', () => ({
  api: {
    post: clientMocks.postVerify,
  },
  getDefaultBaseUrl: () => clientMocks.defaultBaseUrl,
  setAuthToken: clientMocks.setAuthToken,
  setBaseUrl: clientMocks.setBaseUrl,
}))

import {
  H5ConnectionRequiredError,
  H5_SERVER_URL_STORAGE_KEY,
  H5_TOKEN_STORAGE_KEY,
  initializeDesktopServerUrl,
  isLoopbackHostname,
  requiresH5AuthForServerUrl,
} from './desktopRuntime'

describe('desktopRuntime browser H5 bootstrap', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    window.localStorage.clear()
    window.history.pushState({}, '', '/')
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
  })

  it('treats IPv6 loopback as local', () => {
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(requiresH5AuthForServerUrl('http://[::1]:3456')).toBe(false)
    expect(requiresH5AuthForServerUrl('http://127.0.0.1:3456')).toBe(false)
    expect(requiresH5AuthForServerUrl('http://localhost:3456')).toBe(false)
    expect(requiresH5AuthForServerUrl('https://public.example.com/app')).toBe(true)
  })

  it('clears an invalid token but preserves the remembered remote server URL', async () => {
    window.history.pushState({}, '', '/?serverUrl=https%3A%2F%2Fpublic.example.com%2Fapp')
    window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'stale-token')
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    ) as typeof fetch
    clientMocks.postVerify.mockRejectedValueOnce(new Error('Unauthorized'))

    await expect(initializeDesktopServerUrl()).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'https://public.example.com/app',
      message: 'The saved H5 token is no longer valid.',
    } satisfies Partial<H5ConnectionRequiredError>)

    expect(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe(
      'https://public.example.com/app',
    )
    expect(window.localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBeNull()
  })

  it('normalizes unreachable remote browser startup into a recoverable H5 error', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/?serverUrl=https%3A%2F%2Funreachable.example.com')
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as typeof fetch

    const startup = expect(initializeDesktopServerUrl()).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'https://unreachable.example.com',
      message: 'Unable to reach https://unreachable.example.com. Check the server URL or network access.',
    } satisfies Partial<H5ConnectionRequiredError>)
    await vi.runAllTimersAsync()

    await startup

    expect(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe(
      'https://unreachable.example.com',
    )
  })

  it('normalizes remote verify failures like disabled H5 or CORS into recoverable H5 errors', async () => {
    window.history.pushState({}, '', '/?serverUrl=https%3A%2F%2Fpublic.example.com')
    window.localStorage.setItem(H5_TOKEN_STORAGE_KEY, 'h5_token')
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 200 }),
    ) as typeof fetch
    clientMocks.postVerify.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await expect(initializeDesktopServerUrl()).rejects.toMatchObject({
      name: 'H5ConnectionRequiredError',
      serverUrl: 'https://public.example.com',
      message: 'Unable to verify the H5 access token.',
    } satisfies Partial<H5ConnectionRequiredError>)

    expect(window.localStorage.getItem(H5_SERVER_URL_STORAGE_KEY)).toBe(
      'https://public.example.com',
    )
    expect(window.localStorage.getItem(H5_TOKEN_STORAGE_KEY)).toBeNull()
  })
})
