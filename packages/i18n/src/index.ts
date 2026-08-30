import { en } from './en.js'
import { de } from './de.js'

export const LOCALES = ['en', 'de'] as const
export type Locale = (typeof LOCALES)[number]

export type MessageKey = keyof typeof en

/**
 * English is the reference. Every other locale must supply exactly these keys —
 * `satisfies Messages` in each file makes a missing or stray key a build error
 * rather than a blank label somebody notices in production.
 *
 * Values are plain `string`, not the literal types `as const` would give: the
 * point is that German has every key, not that it says the same words.
 */
export type Messages = Record<MessageKey, string>

export const MESSAGES: Record<Locale, Messages> = { en, de }

/** Values interpolated into `{placeholders}`. */
export type Vars = Record<string, string | number>

export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const template = MESSAGES[locale][key] ?? MESSAGES.en[key] ?? String(key)
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

/** Picks the closest supported locale for a browser or OS language tag. */
export function resolveLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0]
    if (base && (LOCALES as readonly string[]).includes(base)) return base as Locale
  }
  return 'en'
}

export { en, de }
