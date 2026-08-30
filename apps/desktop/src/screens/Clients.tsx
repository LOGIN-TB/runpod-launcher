import { useEffect, useState, type ReactNode } from 'react'
import { api, type ClientToken, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Button, Card, EmptyState, Field, Input } from '../components/primitives.js'
import { CopyField } from '../components/CopyField.js'

/**
 * Client tokens, and the recipes for using them.
 *
 * The recipes matter as much as the tokens: the endpoint is a plain
 * OpenAI-compatible one, and most of the work in adopting it is knowing which
 * box to paste the address into for a given tool.
 */
export function Clients({ connection }: { connection: Connection }): ReactNode {
  const { t } = useI18n()
  const [tokens, setTokens] = useState<ClientToken[]>([])
  const [name, setName] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = async (): Promise<void> => {
    setTokens((await api.clientTokens(connection)).tokens)
  }
  useEffect(() => {
    void reload()
  }, [connection])

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const { token } = await api.createClientToken(connection, name || 'Unnamed client')
      setIssued(token)
      setName('')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const endpoint = new URL('/v1', connection.baseUrl).toString()

  return (
    <div className="stack">
      <Card>
        <h2>{t('clients.title')}</h2>
        <p className="muted">{t('clients.intro')}</p>

        <div className="row">
          <Field label={t('clients.name')}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('clients.namePlaceholder')}
            />
          </Field>
          <Button variant="primary" loading={busy} onClick={create}>
            {t('clients.new')}
          </Button>
        </div>

        {issued ? (
          <div className="notice">
            {/* Shown once, on purpose: the service keeps only a hash. */}
            <p>{t('clients.created')}</p>
            <CopyField value={issued} secret />
            <Button variant="ghost" onClick={() => setIssued(null)}>
              {t('action.close')}
            </Button>
          </div>
        ) : null}
      </Card>

      {tokens.length === 0 ? (
        <Card>
          <EmptyState title={t('clients.title')} hint={t('clients.intro')} />
        </Card>
      ) : (
        <Card>
          <ul className="token-list">
            {tokens.map((token) => (
              <li key={token.id}>
                <div>
                  <strong>{token.name}</strong>
                  <span className="muted small">
                    {token.lastUsedAt
                      ? t('clients.lastUsed', { when: new Date(token.lastUsedAt).toLocaleString() })
                      : t('clients.neverUsed')}
                  </span>
                </div>
                {token.revokedAt ? (
                  <Badge tone="stopped">{t('clients.revoked')}</Badge>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      await api.revokeClientToken(connection, token.id)
                      await reload()
                    }}
                  >
                    {t('clients.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h3>{t('clients.recipe')}</h3>
        <ConnectionRecipes endpoint={endpoint} />
      </Card>
    </div>
  )
}

/**
 * Where to paste the address in each tool. Deliberately not n8n-only: the
 * endpoint is ordinary OpenAI, and an agent framework is as valid a client.
 */
function ConnectionRecipes({ endpoint }: { endpoint: string }): ReactNode {
  const recipes: Array<{ client: string; where: string }> = [
    { client: 'n8n', where: 'OpenAI credential → Base URL' },
    { client: 'Open WebUI', where: 'Settings → Connections → OpenAI API' },
    { client: 'LibreChat', where: 'librechat.yaml → custom endpoint → baseURL' },
    { client: 'Hermes / OpenClaw', where: "the agent's OpenAI base URL" },
    { client: 'Python', where: 'OpenAI(base_url=…, api_key=…)' },
  ]

  return (
    <>
      <CopyField value={endpoint} />
      <table className="recipes">
        <tbody>
          {recipes.map((recipe) => (
            <tr key={recipe.client}>
              <th scope="row">{recipe.client}</th>
              <td>{recipe.where}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
