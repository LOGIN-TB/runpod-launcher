import { useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import { api, ApiError, type Connection, type PodView } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Button, Card, EmptyState } from '../components/primitives.js'
import { CopyField } from '../components/CopyField.js'
import { setTrayStatus } from '../lib/storage.js'
import { SpendPanel } from '../components/SpendPanel.js'

const POLL_MS = 5_000

/**
 * The screen you open nine times out of ten to answer one question: is it
 * running, and what is it costing me? Everything else is one click away.
 */
export function Overview({
  connection,
  templates,
  onGoToTemplates,
}: {
  connection: Connection
  templates: Template[]
  onGoToTemplates: () => void
}): ReactNode {
  const { t, money } = useI18n()
  const [view, setView] = useState<PodView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>(templates[0]?.id ?? '')

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const next = await api.pod(connection)
        if (!cancelled) {
          setView(next)
          setError(null)
          // Keeps the menu bar honest even while the window is closed.
          void setTrayStatus(next.pod?.status === 'RUNNING', next.pod?.costPerHour ?? 0)
        }
      } catch (cause) {
        if (!cancelled) setError(describe(cause, t))
      }
    }
    void load()
    // Polling rather than a socket: the interesting states change on the scale
    // of minutes, and a poll survives the service restarting underneath us.
    const timer = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connection, t])

  const status = view?.pod?.status ?? null
  const isRunning = status === 'RUNNING'
  const isStarting = status === 'PROVISIONING' || status === 'STARTING'

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setView(await api.pod(connection))
    } catch (cause) {
      setError(describe(cause, t))
    } finally {
      setBusy(false)
    }
  }

  if (templates.length === 0) {
    return (
      <Card>
        <EmptyState
          title={t('template.none')}
          hint={t('template.noneHint')}
          action={
            <Button variant="primary" onClick={onGoToTemplates}>
              {t('template.new')}
            </Button>
          }
        />
      </Card>
    )
  }

  return (
    <div className="stack">
      <Card className="pod-card">
        <div className="pod-header">
          <div>
            <h2>{t('pod.title')}</h2>
            <Badge tone={isRunning ? 'running' : isStarting ? 'pending' : 'stopped'}>
              {isRunning ? t('pod.running') : isStarting ? t('pod.starting') : status ? t('pod.stopped') : t('pod.none')}
            </Badge>
          </div>
          {/* Cost sits beside the switch, not on a reporting page. A tool that
              bills by the hour should never make you go looking for that. */}
          {view?.pod ? (
            <div className="cost" aria-live="polite">
              <span className="cost-amount">{money(view.pod.costPerHour)}</span>
              <span className="cost-label">{t('pod.costPerHour', { amount: '' }).trim()}</span>
            </div>
          ) : null}
        </div>

        <div className="pod-controls">
          <select
            className="input"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={isRunning || isStarting}
            aria-label={t('template.title')}
          >
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}
              </option>
            ))}
          </select>

          {isRunning || isStarting ? (
            <Button variant="danger" loading={busy} onClick={() => act(() => api.stopPod(connection))}>
              {t('pod.stop')}
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={busy}
              disabled={!selected}
              onClick={() => act(() => api.startPod(connection, selected))}
            >
              {t('pod.start')}
            </Button>
          )}
        </div>

        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </Card>

      <SpendPanel connection={connection} />

      {view?.serving?.chatUrl || view?.serving?.embeddingUrl ? (
        <Card>
          <h3>{t('pod.endpoint')}</h3>
          <CopyField value={new URL('/v1', connection.baseUrl).toString()} />
          <ul className="model-list">
            {view.serving.servedModels.map((model) => (
              <li key={model}>
                <code>{model}</code>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  )
}

/** Turns an exception into something worth reading. */
function describe(cause: unknown, t: (key: 'error.offline' | 'error.generic', vars?: Record<string, string>) => string): string {
  if (cause instanceof ApiError && cause.status === 0) return t('error.offline')
  return t('error.generic', { message: (cause as Error).message })
}
