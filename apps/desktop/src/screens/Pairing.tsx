import { useState, type FormEvent, type ReactNode } from 'react'
import { api, ApiError, type Connection } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Button, Card, Field, Input } from '../components/primitives.js'

/**
 * First contact. Everything else in the app is unreachable until this succeeds,
 * so it has to explain itself without assuming the reader knows what a
 * container log is.
 */
export function Pairing({ onPaired }: { onPaired: (connection: Connection) => void }): ReactNode {
  const { t } = useI18n()
  const [baseUrl, setBaseUrl] = useState('http://localhost:8080')
  const [code, setCode] = useState('')
  const [deviceName, setDeviceName] = useState(defaultDeviceName())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // Check the service answers before blaming the code: "wrong code" when
      // the container is simply not running sends people down the wrong path.
      await api.health(baseUrl).catch(() => {
        throw new ApiError(0, t('pairing.noService'))
      })
      const { token } = await api.pair(baseUrl, code, deviceName)
      onPaired({ baseUrl, token })
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 0
          ? cause.message
          : t('pairing.failed', { reason: (cause as Error).message }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="centre-page">
      <Card className="pairing-card">
        <h1>{t('pairing.title')}</h1>
        <p className="muted">{t('pairing.intro')}</p>

        <form onSubmit={submit} className="stack">
          <Field label={t('pairing.address')} hint={t('pairing.addressHint')}>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://192.168.1.20:8080"
              autoComplete="url"
              required
            />
          </Field>

          <Field label={t('pairing.code')} hint={t('pairing.codeHint')}>
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="ABCD-EFGH-JKLM"
              // The code is read off a screen and retyped, so it is compared
              // case- and whitespace-insensitively by the service.
              spellCheck={false}
              autoCapitalize="characters"
              required
            />
          </Field>

          <Field label={t('pairing.deviceName')}>
            <Input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} required />
          </Field>

          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}

          <Button type="submit" variant="primary" loading={busy}>
            {t('pairing.submit')}
          </Button>
        </form>
      </Card>
    </div>
  )
}

/** A name the user will recognise in the device list later. */
function defaultDeviceName(): string {
  const platform = navigator.platform || ''
  if (/mac/i.test(platform)) return 'Mac'
  if (/win/i.test(platform)) return 'Windows PC'
  if (/linux/i.test(platform)) return 'Linux'
  return 'Desktop'
}
