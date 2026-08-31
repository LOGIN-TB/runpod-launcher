import { useEffect, useState, type ReactNode } from 'react'
import type { PublicSettings } from '@runpod-launcher/shared'
import { LOCALES, type Locale } from '@runpod-launcher/i18n'
import { api, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { useTheme, type Theme } from '../lib/theme.js'
import { Badge, Button, Card, Field, Input } from '../components/primitives.js'

/**
 * Credentials and limits.
 *
 * Secrets are write-only from here: the service returns `hasRunpodApiKey`
 * rather than the key, so this screen can show that one is set without ever
 * holding it. Leaving a field blank means "leave it alone", which is what lets
 * the form be submitted without echoing back a value it was never shown.
 */
export function Settings({ connection }: { connection: Connection }): ReactNode {
  const { t, locale, setLocale } = useI18n()
  const { theme, setTheme } = useTheme()
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [verifying, setVerifying] = useState(false)
  const [verdict, setVerdict] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api.settings(connection).then(setSettings)
  }, [connection])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(drafts)) {
        if (value.trim().length > 0) patch[key] = value.trim()
      }
      if (Object.keys(patch).length > 0) setSettings(await api.saveSettings(connection, patch))
      setDrafts({})
    } finally {
      setSaving(false)
    }
  }

  const verify = async (): Promise<void> => {
    setVerifying(true)
    setVerdict(null)
    try {
      const result = await api.verifyRunpodKey(connection)
      setVerdict(result.valid ? t('settings.verified') : t('settings.verifyFailed'))
    } finally {
      setVerifying(false)
    }
  }

  if (!settings) return <Card>{t('model.checking')}</Card>

  const secret = (key: 'runpodApiKey' | 'huggingfaceToken' | 'notifyWebhookUrl', isSet: boolean, label: string, hint: string): ReactNode => (
    <Field label={label} hint={hint}>
      <div className="row">
        <Input
          type="password"
          value={drafts[key] ?? ''}
          onChange={(event) => setDrafts({ ...drafts, [key]: event.target.value })}
          placeholder={isSet ? '••••••••••••' : ''}
          autoComplete="off"
        />
        <Badge tone={isSet ? 'running' : 'stopped'}>{isSet ? t('settings.set') : t('settings.notSet')}</Badge>
      </div>
    </Field>
  )

  return (
    <div className="stack">
      <Card>
        <h2>{t('settings.title')}</h2>

        {secret('runpodApiKey', settings.hasRunpodApiKey, t('settings.runpodKey'), t('settings.runpodKeyHint'))}
        <div className="row">
          <Button variant="ghost" loading={verifying} onClick={verify} disabled={!settings.hasRunpodApiKey}>
            {t('settings.verify')}
          </Button>
          {verdict ? <span className="muted small">{verdict}</span> : null}
        </div>

        {secret('huggingfaceToken', settings.hasHuggingfaceToken, t('settings.hfToken'), t('settings.hfTokenHint'))}
        {secret('notifyWebhookUrl', settings.hasNotifyWebhookUrl, t('settings.webhook'), t('settings.webhookHint'))}

        <Button variant="primary" loading={saving} onClick={save} disabled={Object.keys(drafts).length === 0}>
          {t('action.save')}
        </Button>
      </Card>

      <Card>
        <h3>{t('settings.spendLimits')}</h3>
        {/* Said once, above the fields: an empty field means no limit. Nothing
            used to say so, and "no limit" is the state in which a forgotten pod
            runs until somebody notices the bill. */}
        <p className="muted small">{t('settings.spendLimitsIntro')}</p>

        {/* Three fields of equal height on one line, then the notes.
            A hint inside one field of a row lifts that field's control above its
            neighbours', which is exactly how this row came out crooked. */}
        <div className="row">
          <Field label={t('settings.dailyLimit')}>
            <Input
              type="number"
              min="0"
              step="1"
              placeholder={t('settings.limitNone')}
              defaultValue={settings.dailyLimitUsd ?? ''}
              onBlur={(event) =>
                void api
                  .saveSettings(connection, { dailyLimitUsd: event.target.value ? Number(event.target.value) : null })
                  .then(setSettings)
              }
            />
          </Field>
          <Field label={t('settings.monthlyLimit')}>
            <Input
              type="number"
              min="0"
              step="1"
              placeholder={t('settings.limitNone')}
              defaultValue={settings.monthlyLimitUsd ?? ''}
              onBlur={(event) =>
                void api
                  .saveSettings(connection, { monthlyLimitUsd: event.target.value ? Number(event.target.value) : null })
                  .then(setSettings)
              }
            />
          </Field>
          {/* Sits with the spend limits because that is what it is: the ceiling
              on how many GPUs can be rented at the same time. */}
          <Field label={t('settings.maxPods')}>
            <Input
              type="number"
              min="1"
              max="10"
              step="1"
              defaultValue={settings.maxConcurrentPods}
              onBlur={(event) =>
                void api
                  .saveSettings(connection, { maxConcurrentPods: Number(event.target.value) })
                  .then(setSettings)
              }
            />
          </Field>
        </div>

        <p className="muted small">{t('settings.maxPodsHint')}</p>
      </Card>

      <Card>
        <Field label={t('settings.theme')} hint={t('settings.themeHint')}>
          <select
            className="input"
            value={theme}
            onChange={(event) => setTheme(event.target.value as Theme)}
          >
            <option value="system">{t('settings.themeSystem')}</option>
            <option value="light">{t('settings.themeLight')}</option>
            <option value="dark">{t('settings.themeDark')}</option>
          </select>
        </Field>

        <Field label={t('settings.language')}>
          <select className="input" value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
            {LOCALES.map((code) => (
              <option key={code} value={code}>
                {code === 'de' ? 'Deutsch' : 'English'}
              </option>
            ))}
          </select>
        </Field>
      </Card>
    </div>
  )
}
