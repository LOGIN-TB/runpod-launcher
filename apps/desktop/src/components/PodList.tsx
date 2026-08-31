import { useEffect, useState, type ReactNode } from 'react'
import type { MessageKey } from '@runpod-launcher/i18n'
import type { Template } from '@runpod-launcher/shared'
import {
  api,
  type ClientToken,
  type Connection,
  type PodStatusReport,
  type Readiness,
  type SelfTestResult,
} from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Button, Card, EmptyState } from './primitives.js'
import { Confirm } from './Confirm.js'

/** Fast while something is coming up, so a state change is visible promptly. */
const POLL_BUSY_MS = 10_000
const POLL_IDLE_MS = 30_000

const TONE: Record<Readiness, 'running' | 'pending' | 'stopped' | 'danger'> = {
  ready: 'running',
  preparing: 'pending',
  provisioning: 'pending',
  failed: 'danger',
  stopped: 'stopped',
}

/**
 * Every pod, what it is doing, and what can be done to it.
 *
 * The readiness is the point. RunPod calls a pod RUNNING within seconds of
 * placing it, while the engine is still fetching twenty gigabytes — and it goes
 * on calling it RUNNING if the engine dies. Reported from a real session:
 * eleven minutes of an apparently running pod with no way to tell downloading
 * from broken.
 *
 * A pod left behind also keeps costing money, so every one of them is listed
 * and every one can be stopped, not merely whichever the launcher considers
 * current.
 */
export function PodList({
  connection,
  templates,
}: {
  connection: Connection
  /** Needed only for each pod's schedule, to warn before its window closes. */
  templates: Template[]
}): ReactNode {
  const { t, money } = useI18n()
  const [pods, setPods] = useState<PodStatusReport[] | null>(null)
  /**
   * Which applications reach which pod.
   *
   * Shown here because this is the list people look at when they are deciding
   * whether a pod can be stopped, and that decision is unanswerable without it.
   * It also makes the expensive case visible: a pod that is running with nothing
   * pointed at it bills by the hour and serves no one.
   */
  const [clients, setClients] = useState<ClientToken[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [test, setTest] = useState<SelfTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const [result, tokens] = await Promise.all([
      api.pods(connection).catch(() => null),
      api.clientTokens(connection).catch(() => null),
    ])
    if (result) setPods(result.pods)
    if (tokens) setClients(tokens.tokens.filter((token) => token.revokedAt === null))
  }

  useEffect(() => {
    void load()
    const anyBusy = pods?.some((pod) => pod.readiness === 'preparing' || pod.readiness === 'provisioning')
    const timer = setInterval(load, anyBusy ? POLL_BUSY_MS : POLL_IDLE_MS)
    return () => clearInterval(timer)
  }, [connection, pods?.some((pod) => pod.readiness === 'preparing')])

  const act = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      await fn()
      await load()
    } catch (cause) {
      // Silently swallowing this is how a dead button looks like a dead
      // feature. RunPod refuses some transitions, and the reason matters.
      setError((cause as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Tests one named pod. With several up, "the active pod" is no longer a
  // single thing, and a result with no pod attached to it says nothing.
  const runTest = async (templateId: string): Promise<void> => {
    setTesting(true)
    setTest(null)
    try {
      setTest(await api.selfTest(connection, templateId))
    } finally {
      setTesting(false)
    }
  }

  if (!pods) return null

  if (pods.length === 0) {
    return (
      <Card>
        <EmptyState title={t('pods.none')} hint={t('pods.noneHint')} />
      </Card>
    )
  }

  return (
    <Card>
      <div className="row space-between">
        <h3>{t('pods.title')}</h3>
      </div>

      {test ? (
        <p className={test.ok ? 'verdict verdict-ok' : 'verdict verdict-bad'}>
          {test.ok
            ? t('selftest.ok', { ms: test.durationMs ?? 0 })
            : t('selftest.failed', { detail: test.detail ?? test.reason ?? '' })}
        </p>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      <Confirm
        open={pendingDelete !== null}
        title={t('pods.delete')}
        body={t('pods.deleteConfirm')}
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete
          setPendingDelete(null)
          if (id) void act(id, () => api.deletePod(connection, id))
        }}
      />

      <ul className="pod-list">
        {pods.map((pod) => (
          <li key={pod.id} className={pod.isActive ? 'pod entry active' : 'pod entry'}>
            <div className="entry-main">
              <div className="row">
                <Badge tone={TONE[pod.readiness]}>{t(`ready.${pod.readiness}` as MessageKey)}</Badge>
                {pod.isActive ? <Badge tone="neutral">{t('pods.active')}</Badge> : null}
              </div>
              <strong>
                {pod.templateName ?? t('pods.unknownTemplate')}
              </strong>
              <span className="muted small">
                {pod.gpu} · {money(pod.costPerHour)}/h
                {pod.runningForSeconds !== null && pod.readiness !== 'stopped' ? (
                  <>
                    {` · ${t('pods.runningFor', { duration: humanise(pod.runningForSeconds) })}`}
                    {/* What this run has cost so far. The hourly rate alone
                        answers "how fast", never "how much", and that is the
                        question somebody has when they look at a pod they
                        forgot to stop. */}
                    {` · ${t('pods.runCost', {
                      amount: money((pod.runningForSeconds / 3600) * pod.costPerHour),
                    })}`}
                  </>
                ) : null}
              </span>
              {/* What "getting ready" means in minutes, so a long wait reads as
                  normal rather than as something being wrong. */}
              {pod.readiness === 'preparing' ? (
                <span className="muted small">{t('ready.preparingHint')}</span>
              ) : null}
              {/* Who is actually using this pod. Named rather than counted: the
                  question is "may I stop this", and a number cannot answer it. */}
              <span className="muted small">
                {(() => {
                  const users = clients.filter((token) => token.templateId === pod.templateId)
                  if (users.length === 0) {
                    return pod.readiness === 'stopped' ? (
                      t('pods.noClients')
                    ) : (
                      // A running pod nobody points at is the case worth
                      // noticing, so it does not read as ordinary grey text.
                      <span className="field-error">{t('pods.noClientsRunning')}</span>
                    )
                  }
                  return t('pods.clients', { names: users.map((token) => token.name).join(', ') })
                })()}
              </span>

              {/* Creating a pod ten minutes before its window closes means
                  paying for a download that gets thrown away. The warning
                  belongs on the pod it concerns, not on a page-wide banner
                  that cannot say which one. */}
              {closingSoonFor(templates, pod.templateId) !== null && pod.readiness !== 'stopped' ? (
                <span className="muted small">
                  {t('pod.windowClosingSoon', {
                    minutes: closingSoonFor(templates, pod.templateId) ?? 0,
                  })}
                </span>
              ) : null}
              {pod.detail ? <span className="field-error">{pod.detail}</span> : null}
            </div>

            <div className="entry-actions">
              {/* A paused pod keeps the model it downloaded, so starting it
                  again is the cheap path — and without this button the only
                  way onward was to delete it and download all over. */}
              {pod.readiness === 'stopped' ? (
                <Button
                  variant="primary"
                  loading={busy === pod.id}
                  onClick={() => act(pod.id, () => api.startOnePod(connection, pod.id))}
                >
                  {t('pods.start')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  loading={busy === pod.id}
                  title={t('pods.stopHint')}
                  onClick={() => act(pod.id, () => api.stopOnePod(connection, pod.id))}
                >
                  {t('pods.stop')}
                </Button>
              )}

              {/* "Running" is not "working". This is the only check that
                  answers the question somebody waiting actually has — and it
                  belongs on the row, so the answer names a pod. */}
              {pod.readiness === 'ready' ? (
                <Button variant="ghost" loading={testing} onClick={() => runTest(pod.templateId)}>
                  {testing ? t('selftest.running') : t('selftest.run')}
                </Button>
              ) : null}

              <Button
                variant="danger"
                loading={busy === pod.id}
                title={t('pods.deleteHint')}
                onClick={() => setPendingDelete(pod.id)}
              >
                {t('pods.delete')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/**
 * Minutes until this pod's window closes, or null when it is not about to.
 *
 * Moved here from the overview, where it could only ever speak about whichever
 * template happened to be picked in a dropdown. A warning that cannot say which
 * pod it means is not much of a warning.
 */
function closingSoonFor(templates: Template[], templateId: string): number | null {
  const schedule = templates.find((candidate) => candidate.id === templateId)?.schedule
  if (!schedule?.enabled || !schedule.stopAt) return null

  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: schedule.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date())
  const [hour = '0', minute = '0'] = local.split(':')
  const [stopHour = '0', stopMinute = '0'] = schedule.stopAt.split(':')

  const remaining = (Number(stopHour) * 60 + Number(stopMinute)) - (Number(hour) * 60 + Number(minute))
  return remaining > 0 && remaining <= 30 ? remaining : null
}

function humanise(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
