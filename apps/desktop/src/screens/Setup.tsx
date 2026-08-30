import { useEffect, useState, type ReactNode } from 'react'
import { api, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Button, Card } from '../components/primitives.js'

/**
 * First-run guide.
 *
 * Each step checks itself against the service rather than asking the user to
 * confirm they did it. Someone new cannot tell a key that was saved from one
 * that was saved wrong, and finding out four minutes into a paid pod start is
 * the worst possible moment.
 */
export function Setup({
  connection,
  onGo,
  onDismiss,
}: {
  connection: Connection
  onGo: (screen: 'settings' | 'templates' | 'overview' | 'clients') => void
  onDismiss: () => void
}): ReactNode {
  const { t } = useI18n()
  const [state, setState] = useState({ key: false, template: false, ranOnce: false, client: false })

  const check = async (): Promise<void> => {
    const [settings, templates, pod, tokens] = await Promise.all([
      api.settings(connection).catch(() => null),
      api.templates(connection).catch(() => null),
      api.pod(connection).catch(() => null),
      api.clientTokens(connection).catch(() => null),
    ])
    setState({
      key: settings?.hasRunpodApiKey ?? false,
      template: (templates?.templates.length ?? 0) > 0,
      // A pod record at all, running or not: the point is that a start has
      // been through once, not that one is up right now.
      ranOnce: pod?.pod !== null && pod?.pod !== undefined,
      client: (tokens?.tokens.filter((token) => !token.revokedAt).length ?? 0) > 0,
    })
  }

  useEffect(() => {
    void check()
  }, [connection])

  const steps = [
    { done: state.key, title: t('setup.1.title'), body: t('setup.1.body'), go: 'settings' as const },
    { done: state.template, title: t('setup.2.title'), body: t('setup.2.body'), go: 'templates' as const },
    { done: state.ranOnce, title: t('setup.3.title'), body: t('setup.3.body'), go: 'overview' as const },
    { done: state.client, title: t('setup.4.title'), body: t('setup.4.body'), go: 'clients' as const },
  ]

  const current = steps.findIndex((step) => !step.done)
  if (current === -1) return null

  return (
    <Card className="setup">
      <div className="row space-between">
        <h2>{t('setup.title')}</h2>
        {/* A count, not "step N of 4": the steps can be finished in any order,
            and calling an unfinished one "step 1" when two are already done is
            simply wrong. */}
        <span className="muted small">
          {t('setup.step', { done: steps.filter((step) => step.done).length, total: steps.length })}
        </span>
      </div>

      <ol className="setup-steps">
        {steps.map((step, index) => (
          <li key={step.title} className={step.done ? 'done' : index === current ? 'current' : 'later'}>
            <div className="row space-between">
              <strong>{step.title}</strong>
              <Badge tone={step.done ? 'running' : 'stopped'}>{step.done ? t('setup.ok') : t('setup.failed')}</Badge>
            </div>
            {/* Only the step in hand is explained. Showing all four at once
                turns a sequence into a wall. */}
            {index === current ? (
              <>
                <p className="muted small">{step.body}</p>
                <div className="row">
                  <Button variant="primary" onClick={() => onGo(step.go)}>
                    {t('setup.next')}
                  </Button>
                  <Button variant="ghost" onClick={check}>
                    {t('setup.check')}
                  </Button>
                </div>
              </>
            ) : null}
          </li>
        ))}
      </ol>

      <Button variant="ghost" onClick={onDismiss}>
        {t('setup.skip')}
      </Button>
    </Card>
  )
}
