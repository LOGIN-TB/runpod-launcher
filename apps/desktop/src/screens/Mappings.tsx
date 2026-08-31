import { useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import {
  api,
  type ClientToken,
  type Connection,
  type PodStatusReport,
  type Readiness,
} from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Card, EmptyState } from '../components/primitives.js'

const POLL_MS = 10_000

/** Same mapping as the pod list, so a state looks the same wherever it appears. */
const TONE: Record<Readiness, 'running' | 'pending' | 'stopped' | 'danger'> = {
  ready: 'running',
  preparing: 'pending',
  provisioning: 'pending',
  failed: 'danger',
  stopped: 'stopped',
}

/**
 * Which application reaches which pod.
 *
 * This is the screen the orchestration actually lives on. Everything else shows
 * pods or accesses on their own; here they are shown as pairs, because the
 * question people arrive with is "is my n8n pointed at the right GPU, and is it
 * up?" — and because a pod nobody points at is money burning quietly, which is
 * only visible once both sides are on the same page.
 */
export function Mappings({ connection }: { connection: Connection }): ReactNode {
  const { t, money } = useI18n()
  const [tokens, setTokens] = useState<ClientToken[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [pods, setPods] = useState<PodStatusReport[]>([])
  const [error, setError] = useState<string | null>(null)

  const reload = async (): Promise<void> => {
    try {
      const [tokenList, templateList, podList] = await Promise.all([
        api.clientTokens(connection),
        api.templates(connection),
        api.pods(connection).catch(() => ({ pods: [] })),
      ])
      setTokens(tokenList.tokens.filter((token) => token.revokedAt === null))
      setTemplates(templateList.templates)
      setPods(podList.pods)
      setError(null)
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  useEffect(() => {
    void reload()
    const timer = setInterval(reload, POLL_MS)
    return () => clearInterval(timer)
  }, [connection])

  const podFor = (templateId: string): PodStatusReport | undefined =>
    pods.find((pod) => pod.templateId === templateId)

  const assign = async (tokenId: string, templateId: string | null): Promise<void> => {
    await api.assignClientToken(connection, tokenId, templateId)
    await reload()
  }

  return (
    <div className="stack">
      <Card>
        <h2>{t('mappings.title')}</h2>
        <p className="muted">{t('mappings.intro')}</p>
        {error ? <p className="notice">{error}</p> : null}
      </Card>

      {tokens.length === 0 ? (
        <Card>
          <EmptyState title={t('mappings.noneTitle')} hint={t('mappings.noneHint')} />
        </Card>
      ) : (
        <Card>
          <table className="recipes">
            <thead>
              <tr>
                <th scope="col">{t('mappings.application')}</th>
                <th scope="col">{t('mappings.target')}</th>
                <th scope="col">{t('mappings.podState')}</th>
                <th scope="col">{t('mappings.rate')}</th>
                <th scope="col">{t('mappings.lastUsed')}</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const pod = token.templateId ? podFor(token.templateId) : undefined
                return (
                  <tr key={token.id}>
                    <th scope="row">{token.name}</th>
                    <td>
                      <select
                        className="input"
                        value={token.templateId ?? ''}
                        onChange={(event) => void assign(token.id, event.target.value || null)}
                      >
                        <option value="">{t('mappings.unassigned')}</option>
                        {templates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {token.templateId === null ? (
                        <Badge tone="stopped">{t('mappings.needsTarget')}</Badge>
                      ) : (
                        <Badge tone={TONE[pod?.readiness ?? 'stopped']}>
                          {t(`ready.${pod?.readiness ?? 'stopped'}`)}
                        </Badge>
                      )}
                    </td>
                    {/* Unit written out as in the pod list; "/h" is the same in
                        both languages. */}
                    <td>{pod ? `${money(pod.costPerHour)}/h` : '—'}</td>
                    <td className="muted small">
                      {token.lastUsedAt
                        ? new Date(token.lastUsedAt).toLocaleString()
                        : t('clients.neverUsed')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <h3>{t('mappings.byTemplate')}</h3>
        <p className="muted small">{t('mappings.byTemplateHint')}</p>
        <ul className="token-list">
          {templates.map((template) => {
            const users = tokens.filter((token) => token.templateId === template.id)
            const pod = podFor(template.id)
            // A pod that is up with nothing pointed at it is the case worth
            // spotting: it bills by the hour and serves no one.
            const orphaned = users.length === 0 && pod !== undefined && pod.readiness !== 'stopped'
            return (
              <li key={template.id}>
                <div>
                  <strong>{template.name}</strong>
                  <span className="muted small">
                    {users.length === 0
                      ? t('mappings.noUsers')
                      : t('mappings.userCount', { count: users.length })}
                  </span>
                </div>
                {orphaned ? <Badge tone="danger">{t('mappings.orphaned')}</Badge> : null}
              </li>
            )
          })}
        </ul>
      </Card>
    </div>
  )
}
