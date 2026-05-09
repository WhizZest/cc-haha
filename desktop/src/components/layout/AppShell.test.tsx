import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initializeDesktopServerUrl: vi.fn(),
  isTauriRuntime: false,
  fetchAll: vi.fn(),
  restoreTabs: vi.fn(),
  connectToSession: vi.fn(),
  tabState: {
    activeTabId: null as string | null,
    tabs: [] as Array<{ sessionId: string; title: string; type: string; status: string }>,
  },
}))

vi.mock('../../lib/desktopRuntime', () => ({
  initializeDesktopServerUrl: mocks.initializeDesktopServerUrl,
  isTauriRuntime: () => mocks.isTauriRuntime,
  isH5ConnectionRequiredError: (error: unknown) =>
    error instanceof Error && error.name === 'H5ConnectionRequiredError',
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { fetchAll: typeof mocks.fetchAll }) => unknown) =>
    selector({ fetchAll: mocks.fetchAll }),
}))

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (state: { sidebarOpen: boolean }) => unknown) =>
    selector({ sidebarOpen: true }),
}))

vi.mock('../../stores/tabStore', () => ({
  SETTINGS_TAB_ID: '__settings__',
  useTabStore: {
    getState: () => ({
      restoreTabs: mocks.restoreTabs,
      activeTabId: mocks.tabState.activeTabId,
      tabs: mocks.tabState.tabs,
      openTab: vi.fn(),
    }),
  },
}))

vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      connectToSession: mocks.connectToSession,
    }),
  },
}))

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => key,
}))

vi.mock('./Sidebar', () => ({
  Sidebar: () => <aside>sidebar loaded</aside>,
}))

vi.mock('./ContentRouter', () => ({
  ContentRouter: () => <section>content loaded</section>,
}))

vi.mock('./TabBar', () => ({
  TabBar: () => <nav>tabs loaded</nav>,
}))

vi.mock('./H5ConnectionView', () => ({
  H5ConnectionView: ({ error, onConnected }: { error?: string | null; onConnected: () => void }) => (
    <div>
      <div>h5 connection view</div>
      <div>{error}</div>
      <button type="button" onClick={onConnected}>retry h5 bootstrap</button>
    </div>
  ),
}))

vi.mock('../shared/Toast', () => ({
  ToastContainer: () => null,
}))

vi.mock('../shared/UpdateChecker', () => ({
  UpdateChecker: () => <div>updates loaded</div>,
}))

import { AppShell } from './AppShell'

describe('AppShell boot flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTauriRuntime = false
    mocks.initializeDesktopServerUrl.mockResolvedValue('http://127.0.0.1:3456')
    mocks.fetchAll.mockResolvedValue(undefined)
    mocks.restoreTabs.mockResolvedValue(undefined)
    mocks.tabState.activeTabId = null
    mocks.tabState.tabs = []
  })

  it('renders the desktop chrome after server and settings bootstrap', async () => {
    render(<AppShell />)

    expect(screen.getByText('app.launching')).toBeInTheDocument()

    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    expect(screen.getByText('tabs loaded')).toBeInTheDocument()
    expect(screen.getByText('content loaded')).toBeInTheDocument()
    expect(screen.getByText('updates loaded')).toBeInTheDocument()
  })

  it('shows startup diagnostics instead of a blank shell when bootstrap fails', async () => {
    mocks.fetchAll.mockRejectedValueOnce(new Error('settings file could not be read'))

    render(<AppShell />)

    expect(await screen.findByText('app.serverFailed')).toBeInTheDocument()
    expect(screen.getByText('settings file could not be read')).toBeInTheDocument()
    expect(screen.queryByText('sidebar loaded')).not.toBeInTheDocument()
  })

  it('keeps the app usable when persisted tab restore fails', async () => {
    mocks.restoreTabs.mockRejectedValueOnce(new Error('old tab payload is invalid'))

    render(<AppShell />)

    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.restoreTabs).toHaveBeenCalled()
    })
    expect(screen.queryByText('app.serverFailed')).not.toBeInTheDocument()
  })

  it('reconnects the restored active session tab after boot', async () => {
    mocks.tabState.activeTabId = 'session-1'
    mocks.tabState.tabs = [
      {
        sessionId: 'session-1',
        title: 'Existing session',
        type: 'session',
        status: 'idle',
      },
    ]

    render(<AppShell />)

    await screen.findByText('sidebar loaded')
    await waitFor(() => {
      expect(mocks.connectToSession).toHaveBeenCalledWith('session-1')
    })
  })

  it('shows the H5 connection view in browser mode when startup needs H5 auth', async () => {
    mocks.initializeDesktopServerUrl.mockRejectedValueOnce(
      Object.assign(new Error('Enter your H5 token to continue.'), {
        name: 'H5ConnectionRequiredError',
        serverUrl: 'https://remote.example.com',
      }),
    )

    render(<AppShell />)

    expect(await screen.findByText('h5 connection view')).toBeInTheDocument()
    expect(screen.getByText('Enter your H5 token to continue.')).toBeInTheDocument()
    expect(screen.queryByText('app.serverFailed')).not.toBeInTheDocument()
  })

  it('retries bootstrap after a successful H5 connection', async () => {
    mocks.initializeDesktopServerUrl
      .mockRejectedValueOnce(
        Object.assign(new Error('The saved H5 token is no longer valid.'), {
          name: 'H5ConnectionRequiredError',
          serverUrl: 'https://remote.example.com',
        }),
      )
      .mockResolvedValueOnce('https://remote.example.com')

    render(<AppShell />)

    expect(await screen.findByText('h5 connection view')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'retry h5 bootstrap' }))

    await screen.findByText('sidebar loaded')
    expect(mocks.initializeDesktopServerUrl).toHaveBeenCalledTimes(2)
    expect(mocks.fetchAll).toHaveBeenCalledTimes(1)
  })

  it('keeps the Tauri startup error path unchanged', async () => {
    mocks.isTauriRuntime = true
    mocks.initializeDesktopServerUrl.mockRejectedValueOnce(
      Object.assign(new Error('desktop server startup failed'), {
        name: 'H5ConnectionRequiredError',
        serverUrl: 'https://remote.example.com',
      }),
    )

    render(<AppShell />)

    expect(await screen.findByText('app.serverFailed')).toBeInTheDocument()
    expect(screen.queryByText('h5 connection view')).not.toBeInTheDocument()
  })
})
