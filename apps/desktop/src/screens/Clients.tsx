import { useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import { api, type ClientToken, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Button, Card, EmptyState, Field, Input } from '../components/primitives.js'
import { CopyField } from '../components/CopyField.js'
import { Confirm } from '../components/Confirm.js'

/**
 * Client tokens, and the recipes for using them.
 *
 * The recipes matter as much as the tokens: the endpoint is a plain
 * OpenAI-compatible one, and most of the work in adopting it is knowing which
 * box to paste the address into for a given tool.
 */
export function Clients({ connection }: { connection: Connection }): ReactNode {
  const { t, dateTime } = useI18n()
  const [tokens, setTokens] = useState<ClientToken[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [name, setName] = useState('')
  // The pod this access will reach. Asked at creation so a new access works on
  // its first request instead of being refused for having no target.
  const [target, setTarget] = useState('')
  const [issued, setIssued] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // `window.confirm` does nothing in a Tauri webview, so removals ask here.
  const [pendingDelete, setPendingDelete] = useState<ClientToken | null>(null)

  const reload = async (): Promise<void> => {
    const [tokenList, templateList] = await Promise.all([
      api.clientTokens(connection),
      api.templates(connection),
    ])
    setTokens(tokenList.tokens)
    setTemplates(templateList.templates)
    setTarget((current) => current || (templateList.templates[0]?.id ?? ''))
  }
  useEffect(() => {
    void reload()
  }, [connection])

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const { token } = await api.createClientToken(
        connection,
        name || 'Unnamed client',
        target || null,
      )
      setIssued(token)
      setName('')
      await reload()
    } finally {
      setBusy(false)
    }
  }

  const endpoint = new URL('/v1', connection.baseUrl).toString()
  const modelsOf = (templateId: string | null): string[] => {
    const template = templates.find((candidate) => candidate.id === templateId)
    if (!template) return []
    return [template.chatModel, template.embeddingModel]
      .filter((slot): slot is NonNullable<typeof slot> => slot !== null)
      .map((slot) => slot.servedName ?? slot.repoId)
  }

  return (
    <div className="stack">
      <Card>
        <h2>{t('clients.title')}</h2>
        <p className="muted">{t('clients.intro')}</p>

        {/* Two fields of equal height on one line, then the hint, then the
            action. A hint inside one field of a row lifts that field's control
            above its neighbour's and drags the button down with it — which is
            exactly how this row came out crooked. */}
        <div className="row">
          <Field label={t('clients.name')}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('clients.namePlaceholder')}
            />
          </Field>
          <Field label={t('clients.target')}>
            <select
              className="input"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <p className="muted small">{t('clients.targetHint')}</p>

        <div className="row end">
          <Button variant="primary" loading={busy} disabled={templates.length === 0} onClick={create}>
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
                      ? t('clients.lastUsed', { when: dateTime(token.lastUsedAt) })
                      : t('clients.neverUsed')}
                  </span>
                </div>

                {/* Both states put their controls in one group, so the rows
                    line up on the right edge whatever they contain. */}
                <div className="token-actions">
                  {/* Re-pointing here changes nothing on the client's side: the
                      credential it holds stays valid. */}
                  {token.revokedAt ? (
                    <>
                      <Badge tone="stopped">{t('clients.revoked')}</Badge>
                      {/* Only once it is blocked. Removing an active access
                          would make tidying the list into an outage. */}
                      <Button variant="danger" onClick={() => setPendingDelete(token)}>
                        {t('clients.delete')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <select
                        className="input"
                        value={token.templateId ?? ''}
                        onChange={async (event) => {
                          await api.assignClientToken(connection, token.id, event.target.value || null)
                          await reload()
                        }}
                      >
                        <option value="">{t('clients.unassigned')}</option>
                        {templates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="ghost"
                        onClick={async () => {
                          await api.revokeClientToken(connection, token.id)
                          await reload()
                        }}
                      >
                        {t('clients.revoke')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Confirm
        open={pendingDelete !== null}
        title={t('clients.deleteTitle')}
        body={t('clients.deleteBody', { name: pendingDelete?.name ?? '' })}
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) await api.deleteClientToken(connection, target.id)
          await reload()
        }}
      />

      <Card>
        <h3>{t('clients.recipe')}</h3>
        <ConnectionRecipes endpoint={endpoint} models={modelsOf(target || null)} />
      </Card>
    </div>
  )
}

/**
 * Where to paste the address in each tool. Deliberately not n8n-only: the
 * endpoint is ordinary OpenAI, and an agent framework is as valid a client.
 */
function ConnectionRecipes({ endpoint, models }: { endpoint: string; models: string[] }): ReactNode {
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
      {/* The model name belongs to the selected template. Naming any other
          would have the client ask for something its pod does not serve. */}
      {models.map((model) => (
        <CopyField key={model} value={model} />
      ))}
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
