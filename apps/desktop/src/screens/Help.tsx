import { useState, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n.js'
import { Button, Card } from '../components/primitives.js'
import { CopyField } from '../components/CopyField.js'

const COMPOSE = `services:
  launcher:
    image: ghcr.io/login-tb/runpod-launcher:latest
    restart: unless-stopped
    environment:
      - SERVICE_FQDN_LAUNCHER_8080
      - PAIRING_CODE=\${SERVICE_PASSWORD_PAIRING:-}
      - TLS_MODE=\${TLS_MODE:-self}
      - PORT=8080
    ports:
      - "8080:8080"
    volumes:
      - launcher-data:/data

volumes:
  launcher-data:`

/**
 * How to install the service, in the app rather than in a README nobody opens
 * at the moment they need it.
 *
 * Two routes, because the two audiences are different: someone with a shell and
 * someone with Coolify. Each is complete on its own — a page that mixes them
 * makes the reader work out which half applies to them.
 */
export function Help(): ReactNode {
  const { t } = useI18n()
  const [route, setRoute] = useState<'docker' | 'coolify'>('docker')

  return (
    <div className="stack">
      <Card>
        <h2>{t('help.install.title')}</h2>
        <p className="muted">{t('help.install.intro')}</p>

        <div className="tabs" role="tablist">
          {(['docker', 'coolify'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={route === option}
              className={route === option ? 'tab active' : 'tab'}
              onClick={() => setRoute(option)}
            >
              {t(option === 'docker' ? 'help.install.docker' : 'help.install.coolify')}
            </button>
          ))}
        </div>

        {route === 'docker' ? (
          <>
            <p className="muted small">{t('help.install.dockerSteps')}</p>
            <pre className="code-block">{COMPOSE}</pre>
            <CopyField value="docker compose up -d && docker compose logs | grep -A4 'Pair the launcher'" />
          </>
        ) : (
          <>
            <p className="muted small">{t('help.install.coolifySteps')}</p>
            <CopyField value="https://github.com/LOGIN-TB/runpod-launcher" />
          </>
        )}
      </Card>

      <Card>
        <h3>{t('help.install.noServer')}</h3>
        <p className="muted">{t('help.install.noServerHint')}</p>
      </Card>
    </div>
  )
}
