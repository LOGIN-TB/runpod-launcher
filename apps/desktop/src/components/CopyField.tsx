import { useState, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n.js'
import { Button } from './primitives.js'

/** A read-only value with a copy button — addresses, tokens, commands. */
export function CopyField({ value, secret = false }: { value: string; secret?: boolean }): ReactNode {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="copy-field">
      <code className={secret ? 'copy-value secret' : 'copy-value'}>{value}</code>
      <Button variant="ghost" onClick={copy}>
        {copied ? t('action.copied') : t('action.copy')}
      </Button>
    </div>
  )
}
