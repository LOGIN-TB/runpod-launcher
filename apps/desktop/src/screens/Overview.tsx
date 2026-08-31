import { useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import { api, ApiError, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Button, Card, EmptyState } from '../components/primitives.js'
import { CopyField } from '../components/CopyField.js'
import { setTrayStatus } from '../lib/storage.js'
import { SpendPanel } from '../components/SpendPanel.js'
import { PodList } from '../components/PodList.js'
import { Activity } from '../components/Activity.js'

const POLL_MS = 5_000

/**
 * The screen you open nine times out of ten to answer one question: is it
 * running, and what is it costing me? Everything else is one click away.
 */
export function Overview({
  connection,
  templates,
  onGoToTemplates,
  onGoToCosts,
}: {
  connection: Connection
  templates: Template[]
  onGoToTemplates: () => void
  onGoToCosts: () => void
}): ReactNode {
  const { t } = useI18n()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const { pods } = await api.pods(connection)
        if (cancelled) return
        setError(null)
        // The menu bar speaks for the whole launcher rather than for one
        // template: every running pod, and what they cost together.
        const live = pods.filter((pod) => pod.readiness !== 'stopped')
        void setTrayStatus(
          live.length > 0,
          live.reduce((total, pod) => total + pod.costPerHour, 0),
        )
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
      {error ? (
        <Card>
          <p className="field-error" role="alert">
            {error}
          </p>
        </Card>
      ) : null}

      {/* Every pod, with what it is doing and how to stop it. This is the whole
          answer now: a second start button above it, with its own template
          picker, only asked the same question twice — and creating a pod is a
          decision about a template, which is where the templates are. */}
      <PodList connection={connection} templates={templates} />

      <SpendPanel connection={connection} onGoToCosts={onGoToCosts} />

      {/* Why anything changed, which the audit log knew all along. */}
      <Activity connection={connection} />

      <Card>
        <h3>{t('pod.endpoint')}</h3>
        <CopyField value={new URL('/v1', connection.baseUrl).toString()} />
        {/* One address for every client. Which model each of them actually
            reaches depends on the access it uses, so naming a model here would
            be a guess as soon as there is more than one pod. */}
        <p className="muted small">{t('pod.endpointHint')}</p>
      </Card>
    </div>
  )
}

/** Turns an exception into something worth reading. */
function describe(cause: unknown, t: (key: 'error.offline' | 'error.generic', vars?: Record<string, string>) => string): string {
  if (cause instanceof ApiError && cause.status === 0) return t('error.offline')
  return t('error.generic', { message: (cause as Error).message })
}
