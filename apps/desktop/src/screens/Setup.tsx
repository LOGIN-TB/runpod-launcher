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
  /**
   * Where a step sends you.
   *
   * Deliberately without 'overview': this guide is shown on every screen
   * including that one, so sending somebody to the screen they are already
   * looking at is a button that does nothing. The third step used to do exactly
   * that — and after the pod controls moved to the template list, the overview
   * was not even the right place any more.
   */
  onGo: (screen: 'settings' | 'templates' | 'clients') => void
  onDismiss: () => void
}): ReactNode {
  const { t } = useI18n()
  const [state, setState] = useState({ key: false, template: false, ranOnce: false, client: false })
  /**
   * Whether a check has just run without changing anything.
   *
   * A button that silently does the same thing again is indistinguishable from
   * a button that does nothing — which is how "check again" came to look broken
   * even once it worked.
   */
  const [checking, setChecking] = useState(false)
  const [checkedInVain, setCheckedInVain] = useState(false)

  const check = async (): Promise<typeof state> => {
    const [settings, templates, pod, tokens] = await Promise.all([
      api.settings(connection).catch(() => null),
      api.templates(connection).catch(() => null),
      api.pod(connection).catch(() => null),
      api.clientTokens(connection).catch(() => null),
    ])
    const next = {
      key: settings?.hasRunpodApiKey ?? false,
      template: (templates?.templates.length ?? 0) > 0,
      // A pod record at all, running or not: the point is that a start has been
      // through once, not that one is up right now. Read from the live pod
      // before, so the step reopened itself every time the pod stopped.
      ranOnce: pod?.everStarted ?? false,
      client: (tokens?.tokens.filter((token) => !token.revokedAt).length ?? 0) > 0,
    }
    setState(next)
    return next
  }

  useEffect(() => {
    void check()
  }, [connection])

  const steps = [
    { field: 'key' as const, title: t('setup.1.title'), body: t('setup.1.body'), go: 'settings' as const },
    { field: 'template' as const, title: t('setup.2.title'), body: t('setup.2.body'), go: 'templates' as const },
    // To the templates: a pod is created from the template it should use, and
    // that is where the button for it lives.
    { field: 'ranOnce' as const, title: t('setup.3.title'), body: t('setup.3.body'), go: 'templates' as const },
    { field: 'client' as const, title: t('setup.4.title'), body: t('setup.4.body'), go: 'clients' as const },
  ]

  // Named rather than positional: a step's completion is looked up by the field
  // it stands for, so reordering the list cannot silently pair a step with
  // another one's answer.
  const current = steps.findIndex((step) => !state[step.field])
  if (current === -1) return null

  return (
    <Card className="setup">
      <div className="row space-between">
        <h2>{t('setup.title')}</h2>
        {/* A count, not "step N of 4": the steps can be finished in any order,
            and calling an unfinished one "step 1" when two are already done is
            simply wrong. */}
        <span className="muted small">
          {t('setup.step', {
            done: steps.filter((step) => state[step.field]).length,
            total: steps.length,
          })}
        </span>
      </div>

      <ol className="setup-steps">
        {steps.map((step, index) => (
          <li
            key={step.title}
            className={state[step.field] ? 'done' : index === current ? 'current' : 'later'}
          >
            <div className="row space-between">
              <strong>{step.title}</strong>
              <Badge tone={state[step.field] ? 'running' : 'stopped'}>
                {state[step.field] ? t('setup.ok') : t('setup.failed')}
              </Badge>
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
                  <Button
                    variant="ghost"
                    loading={checking}
                    onClick={async () => {
                      setChecking(true)
                      setCheckedInVain(false)
                      try {
                        const next = await check()
                        // Still open after looking: say so, rather than leaving
                        // the click looking like it went nowhere.
                        setCheckedInVain(!next[step.field])
                      } finally {
                        setChecking(false)
                      }
                    }}
                  >
                    {t('setup.check')}
                  </Button>
                </div>
                {checkedInVain ? <p className="muted small">{t('setup.stillOpen')}</p> : null}
              </>
            ) : null}
          </li>
        ))}
      </ol>

      {/* Named for the screenshot run, which has to put the guide away to
          photograph the screen underneath it. */}
      <Button variant="ghost" data-action="skip-setup" onClick={onDismiss}>
        {t('setup.skip')}
      </Button>
    </Card>
  )
}
