import { useEffect, useState, type ReactNode } from 'react'
import type { MessageKey } from '@runpod-launcher/i18n'
import { api, type ActivityEvent, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Card } from './primitives.js'

/**
 * Recent events, so an unexplained change has an explanation.
 *
 * The case this comes from: a pod the user had waited eleven minutes for was
 * stopped by the schedule a moment after it became ready. The reason was in the
 * audit log the whole time and nowhere on screen, so it read as a failure.
 */
export function Activity({ connection }: { connection: Connection }): ReactNode {
  const { t } = useI18n()
  const [events, setEvents] = useState<ActivityEvent[]>([])

  useEffect(() => {
    const load = (): void => {
      void api.activity(connection).then((result) => setEvents(result.events)).catch(() => undefined)
    }
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [connection])

  if (events.length === 0) return null

  return (
    <Card>
      <h3>{t('activity.title')}</h3>
      <ul className="activity">
        {events.slice(0, 8).map((event, index) => (
          <li key={`${event.at}-${index}`}>
            <span className="muted small">{new Date(event.at).toLocaleTimeString()}</span>
            <span>{describe(event, t)}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function describe(event: ActivityEvent, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  const name = String(event.detail?.template ?? event.detail?.name ?? '')
  const reason = event.detail?.reason ? t(`schedule.reason.${event.detail.reason}` as MessageKey) : null
  const by = t(event.by === 'schedule' ? 'activity.bySchedule' : 'activity.byYou')

  switch (event.action) {
    case 'pod.start':
      return t('activity.started', { by, template: name })
    case 'pod.stop':
      // The reason is the whole point: "the schedule stopped it because the
      // window closed" and "it crashed" look identical without it.
      return reason ? t('activity.stoppedBecause', { by, reason }) : t('activity.stopped', { by })
    case 'pod.terminate':
      // A pod cleared away automatically needs saying so; otherwise it looks
      // as though something deleted it for no reason.
      return event.detail?.reason === 'superseded'
        ? t('activity.superseded')
        : t('activity.deleted', { by })
    case 'template.created':
      return t('activity.templateCreated', { name })
    case 'template.deleted':
      return t('activity.templateDeleted', { name })
    case 'clientToken.issued':
      return t('activity.tokenIssued', { name })
    case 'settings.updated':
      return t('activity.settingsChanged')
    default:
      return event.action
  }
}
