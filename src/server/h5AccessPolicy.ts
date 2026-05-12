export type H5RequestKind = 'local-trusted' | 'internal-sdk' | 'h5-browser'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const LOCAL_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
])

export function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
}

export function isLoopbackHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(normalizeHostname(hostname))
}

function isLocalOrigin(origin: string | null): boolean {
  if (!origin) return true
  if (LOCAL_ORIGINS.has(origin)) return true

  try {
    return isLoopbackHost(new URL(origin).hostname)
  } catch {
    return false
  }
}

export function classifyH5Request(request: Request, url: URL): H5RequestKind {
  const localTrusted = isLoopbackHost(url.hostname) && isLocalOrigin(request.headers.get('Origin'))

  if (url.pathname.startsWith('/sdk/') && localTrusted) {
    return 'internal-sdk'
  }

  if (localTrusted) {
    return 'local-trusted'
  }

  return 'h5-browser'
}

export function shouldRequireH5Token({
  request,
  url,
  h5Enabled,
  explicitAuthRequired,
}: {
  request: Request
  url: URL
  h5Enabled: boolean
  explicitAuthRequired: boolean
}): boolean {
  if (explicitAuthRequired) {
    return true
  }

  if (!h5Enabled) {
    return false
  }

  return classifyH5Request(request, url) === 'h5-browser'
}
