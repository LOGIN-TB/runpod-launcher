import { useEffect, useState, type ReactNode } from 'react'
import type { MessageKey } from '@runpod-launcher/i18n'
import { api, type Connection, type PodStatusReport, type Readiness, type SelfTestResult } from '../lib/api.js'
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
export function PodList({ connection }: { connection: Connection }): ReactNode {
  const { t, money } = useI18n()
  const [pods, setPods] = useState<PodStatusReport[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [test, setTest] = useState<SelfTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    const result = await api.pods(connection).catch(() => null)
    if (result) setPods(result.pods)
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

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTest(null)
    try {
      setTest(await api.selfTest(connection))
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

  const active = pods.find((pod) => pod.isActive)

  return (
    <Card>
      <div className="row space-between">
        <h3>{t('pods.title')}</h3>
        {/* "Running" is not "working". This is the only check that answers the
            question somebody waiting actually has. */}
        {active?.readiness === 'ready' ? (
          <Button variant="ghost" loading={testing} onClick={runTest}>
            {testing ? t('selftest.running') : t('selftest.run')}
          </Button>
        ) : null}
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
          <li key={pod.id} className={pod.isActive ? 'pod active' : 'pod'}>
            <div className="pod-main">
              <div className="row">
                <Badge tone={TONE[pod.readiness]}>{t(`ready.${pod.readiness}` as MessageKey)}</Badge>
                {pod.isActive ? <Badge tone="neutral">{t('pods.active')}</Badge> : null}
              </div>
              <strong>
                {pod.templateName ?? t('pods.unknownTemplate')}
              </strong>
              <span className="muted small">
                {pod.gpu} · {money(pod.costPerHour)}/h
                {pod.runningForSeconds !== null && pod.readiness !== 'stopped'
                  ? ` · ${t('pods.runningFor', { duration: humanise(pod.runningForSeconds) })}`
                  : ''}
              </span>
              {/* What "getting ready" means in minutes, so a long wait reads as
                  normal rather than as something being wrong. */}
              {pod.readiness === 'preparing' ? (
                <span className="muted small">{t('ready.preparingHint')}</span>
              ) : null}
              {pod.detail ? <span className="field-error">{pod.detail}</span> : null}
            </div>

            <div className="pod-actions">
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

              {!pod.isActive && pod.readiness === 'ready' ? (
                <Button
                  variant="secondary"
                  loading={busy === pod.id}
                  onClick={() => act(pod.id, () => api.selectPod(connection, pod.id))}
                >
                  {t('pods.use')}
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

function humanise(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}
