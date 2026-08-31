import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import { api, type Connection } from './lib/api.js'
import { loadConnection, saveConnection } from './lib/storage.js'
import { useI18n } from './lib/i18n.js'
import { Pairing } from './screens/Pairing.js'
import { Overview } from './screens/Overview.js'
import { Templates } from './screens/Templates.js'
import { Clients } from './screens/Clients.js'
import { Mappings } from './screens/Mappings.js'
import { Settings } from './screens/Settings.js'
import { Help } from './screens/Help.js'
import { Setup } from './screens/Setup.js'

type Screen = 'overview' | 'templates' | 'clients' | 'mappings' | 'settings' | 'help'

export function App(): ReactNode {
  const { t } = useI18n()
  // The credential store is asynchronous, so the connection is loaded rather
  // than read synchronously at first render.
  const [connection, setConnection] = useState<Connection | null>(null)
  const [loading, setLoading] = useState(true)
  const [screen, setScreen] = useState<Screen>('overview')
  const [templates, setTemplates] = useState<Template[]>([])
  const [showSetup, setShowSetup] = useState(true)

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
    void loadConnection()
      .then(setConnection)
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    void reloadTemplates()
  }, [reloadTemplates])

  // Rendering the pairing screen before the keychain has answered would flash
  // it in front of someone who paired months ago.
  if (loading) return <div className="centre-page" />

  if (!connection) {
    return (
      <Pairing
        onPaired={(next) => {
          void saveConnection(next)
          setConnection(next)
        }}
      />
    )
  }

  const nav: Array<{ id: Screen; label: string }> = [
    { id: 'overview', label: t('nav.overview') },
    { id: 'templates', label: t('nav.templates') },
    { id: 'clients', label: t('nav.clients') },
    { id: 'mappings', label: t('nav.mappings') },
    { id: 'settings', label: t('nav.settings') },
    { id: 'help', label: t('nav.help') },
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
            /* Named so the screenshot run can find a screen without counting
               positions in a list that is translated and does change. */
            data-screen={item.id}
            onClick={() => setScreen(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {/* The guide sits above whatever screen is open and disappears on its
            own once every step checks out. */}
        {showSetup && screen !== 'help' ? (
          <Setup connection={connection} onGo={setScreen} onDismiss={() => setShowSetup(false)} />
        ) : null}

        {screen === 'overview' ? (
          <Overview connection={connection} templates={templates} onGoToTemplates={() => setScreen('templates')} />
        ) : null}
        {screen === 'templates' ? (
          <Templates connection={connection} templates={templates} onChanged={reloadTemplates} />
        ) : null}
        {screen === 'clients' ? <Clients connection={connection} /> : null}
        {screen === 'mappings' ? <Mappings connection={connection} /> : null}
        {screen === 'settings' ? <Settings connection={connection} /> : null}
        {screen === 'help' ? <Help /> : null}
      </main>
    </div>
  )
}
