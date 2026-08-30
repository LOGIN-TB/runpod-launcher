import type { SettingsStore } from '../store/settings.js'

/**
 * Sends events to a webhook — an n8n workflow, or anything that accepts a POST.
 *
 * Deliberately not email or Telegram: making the launcher speak one messaging
 * protocol would mean choosing it for everyone. A webhook lets the receiving
 * end decide, and most people already run something that can forward it.
 */
export type NotificationKind =
  | 'spend-limit-reached'
  | 'max-runtime-reached'
  | 'pod-start-failed'
  | 'pod-started'
  | 'pod-stopped'

export interface Notification {
  kind: NotificationKind
  message: string
  details: Record<string, unknown>
}

/**
 * Anything that can deliver a notification.
 *
 * The scheduler depends on this rather than on the webhook implementation, so
 * a different delivery route — or none at all in a test — needs no change to
 * the scheduling code.
 */
export interface NotificationSink {
  send(notification: Notification): Promise<void>
}

export class Notifier implements NotificationSink {
  constructor(
    private readonly settings: SettingsStore,
    private readonly log: { warn: (obj: unknown, msg: string) => void },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(notification: Notification): Promise<void> {
    const url = this.settings.secret('notifyWebhookUrl')
    if (!url) return

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'runpod-launcher',
          at: new Date().toISOString(),
          ...notification,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        this.log.warn({ status: response.status, kind: notification.kind }, 'webhook rejected the notification')
      }
    } catch (error) {
      // A dead webhook must never stop the pod being stopped. Losing the
      // message is bad; losing the cost cap because of it would be worse.
      this.log.warn({ error: (error as Error).message, kind: notification.kind }, 'could not reach the webhook')
    }
  }
}
