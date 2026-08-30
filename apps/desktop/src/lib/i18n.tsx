import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { resolveLocale, translate, type Locale, type MessageKey, type Vars } from '@runpod-launcher/i18n'

const STORAGE_KEY = 'launcher.locale'

interface I18nValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: MessageKey, vars?: Vars) => string
  /** Locale-aware money and number formatting, so strings never hard-code separators. */
  money: (usd: number) => string
  number: (value: number, options?: Intl.NumberFormatOptions) => string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'de' || stored === 'en') return stored
    return resolveLocale(navigator.languages ?? [navigator.language])
  })

  const value = useMemo<I18nValue>(() => {
    const tag = locale === 'de' ? 'de-DE' : 'en-US'
    return {
      locale,
      setLocale: (next) => {
        localStorage.setItem(STORAGE_KEY, next)
        setLocaleState(next)
      },
      t: (key, vars) => translate(locale, key, vars),
      // Prices come from RunPod in USD; showing them in another currency would
      // mean inventing an exchange rate the bill does not use.
      money: (usd) =>
        new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(usd),
      number: (n, options) => new Intl.NumberFormat(tag, options).format(n),
    }
  }, [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (!value) throw new Error('useI18n must be used inside I18nProvider')
  return value
}
