import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import { api, type Connection } from './lib/api.js'
import { useI18n } from './lib/i18n.js'
import { Pairing } from './screens/Pairing.js'
import { Overview } from './screens/Overview.js'
import { Templates } from './screens/Templates.js'
import { Clients } from './screens/Clients.js'
import { Settings } from './screens/Settings.js'

const STORAGE_KEY = 'launcher.connection'

type Screen = 'overview' | 'templates' | 'clients' | 'settings'

export function App(): ReactNode {
  const { t } = useI18n()
  const [connection, setConnection] = useState<Connection | null>(loadConnection)
  const [screen, setScreen] = useState<Screen>('overview')
  const [templates, setTemplates] = useState<Template[]>([])

  const reloadTemplates = useCallback(async (): Promise<void> => {
    if (!connection) return
    try {
      setTemplates((await api.templates(connection)).templates)
    } catch {
      // A failure here is not fatal: the overview reports connectivity itself,
      // and an empty list simply shows the empty state.
    }
  }, [connection])

  useEffect(() => {
    void reloadTemplates()
  }, [reloadTemplates])

  if (!connection) {
    return (
      <Pairing
        onPaired={(next) => {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
          setConnection(next)
        }}
      />
    )
  }

  const nav: Array<{ id: Screen; label: string }> = [
    { id: 'overview', label: t('nav.overview') },
    { id: 'templates', label: t('nav.templates') },
    { id: 'clients', label: t('nav.clients') },
    { id: 'settings', label: t('nav.settings') },
  ]

  return (
    <div className="shell">
      <nav className="sidebar" aria-label={t('app.name')}>
        <div className="brand">{t('app.name')}</div>
        {nav.map((item) => (
          <button
            key={item.id}
            type="button"
            className={screen === item.id ? 'nav-item active' : 'nav-item'}
            aria-current={screen === item.id ? 'page' : undefined}
            onClick={() => setScreen(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {screen === 'overview' ? (
          <Overview connection={connection} templates={templates} onGoToTemplates={() => setScreen('templates')} />
        ) : null}
        {screen === 'templates' ? (
          <Templates connection={connection} templates={templates} onChanged={reloadTemplates} />
        ) : null}
        {screen === 'clients' ? <Clients connection={connection} /> : null}
        {screen === 'settings' ? <Settings connection={connection} /> : null}
      </main>
    </div>
  )
}

function loadConnection(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Connection
    return parsed.baseUrl && parsed.token ? parsed : null
  } catch {
    return null
  }
}
