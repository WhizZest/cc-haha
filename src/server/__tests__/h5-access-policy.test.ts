import { describe, expect, test } from 'bun:test'
import {
  classifyH5Request,
  isLoopbackHost,
  shouldRequireH5Token,
} from '../h5AccessPolicy.js'

function req(url: string, init: RequestInit = {}) {
  return new Request(url, init)
}

describe('h5AccessPolicy', () => {
  test('recognizes loopback hosts as local trusted requests', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('192.168.0.20')).toBe(false)
  })

  test('keeps Tauri WebView requests to loopback tokenless', () => {
    const request = req('http://127.0.0.1:3456/api/status', {
      headers: { Origin: 'http://tauri.localhost' },
    })
    expect(classifyH5Request(request, new URL(request.url))).toBe('local-trusted')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, explicitAuthRequired: false })).toBe(false)
  })

  test('keeps local internal SDK websocket routes tokenless', () => {
    const request = req('http://127.0.0.1:3456/sdk/session-1')
    expect(classifyH5Request(request, new URL(request.url))).toBe('internal-sdk')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, explicitAuthRequired: false })).toBe(false)
  })

  test('does not trust remote SDK websocket routes by path alone', () => {
    const request = req('http://192.168.0.20:3456/sdk/session-1')
    expect(classifyH5Request(request, new URL(request.url))).toBe('h5-browser')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, explicitAuthRequired: false })).toBe(true)
  })

  test('keeps adapter API routes tokenless for local integrations', () => {
    const request = req('http://127.0.0.1:3456/api/adapters')
    expect(classifyH5Request(request, new URL(request.url))).toBe('local-trusted')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, explicitAuthRequired: false })).toBe(false)
  })

  test('does not trust loopback adapter requests from non-local browser origins', () => {
    const request = req('http://127.0.0.1:3456/api/adapters', {
      headers: { Origin: 'https://blocked.example.com' },
    })
    expect(classifyH5Request(request, new URL(request.url))).toBe('h5-browser')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, explicitAuthRequired: false })).toBe(true)
  })

  test('keeps local desktop chat websocket routes tokenless', () => {
    for (const init of [{}, { headers: { Origin: 'http://tauri.localhost' } }]) {
      const request = req('http://127.0.0.1:3456/ws/session-1', init)
      expect(classifyH5Request(request, new URL(request.url))).toBe('local-trusted')
      expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, explicitAuthRequired: false })).toBe(false)
    }
  })

  test('requires H5 token for LAN browser API, proxy, and chat websocket routes when enabled', () => {
    for (const pathname of ['/api/status', '/proxy/openai/v1/chat/completions', '/ws/session-1']) {
      const request = req(`http://192.168.0.20:3456${pathname}`, {
        headers: { Origin: 'http://192.168.0.20:3456' },
      })
      expect(classifyH5Request(request, new URL(request.url))).toBe('h5-browser')
      expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: true, explicitAuthRequired: false })).toBe(true)
    }
  })

  test('explicit deployment auth still requires auth even when H5 is disabled', () => {
    const request = req('http://127.0.0.1:3456/api/status')
    expect(shouldRequireH5Token({ request, url: new URL(request.url), h5Enabled: false, explicitAuthRequired: true })).toBe(true)
  })
})
