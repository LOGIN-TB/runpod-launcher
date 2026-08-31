import { z } from 'zod'

/**
 * Everything the user types into the app rather than into a file.
 *
 * Secret fields never leave the service in plaintext: the API returns them as
 * `null` plus a `hasX` flag, so the UI can show "set" without ever holding the
 * value.
 */
export const settingsSchema = z.object({
  runpodApiKey: z.string().min(1).nullable().default(null),
  huggingfaceToken: z.string().min(1).nullable().default(null),
  /** Where alerts go. n8n is the obvious receiver, but any webhook works. */
  notifyWebhookUrl: z.string().url().nullable().default(null),

  /** Origins allowed to call the gateway from a browser. */
  corsOrigins: z.array(z.string()).default([]),
  /**
   * How long the gateway holds a request while a sleeping pod boots, before
   * giving up with 503. Clients that know about /wake need none of this;
   * arbitrary agents do.
   */
  wakeWaitSeconds: z.number().int().min(0).max(900).default(240),

  /**
   * How many pods may run at the same time.
   *
   * Each one is a rented GPU, so this is the guard that keeps a few mappings
   * from becoming a few simultaneous bills. The daily and monthly limits still
   * apply to all of them together.
   */
  maxConcurrentPods: z.number().int().min(1).max(10).default(2),

  /** Hard spend limits. The scheduler force-stops the pod when either is hit. */
  dailyLimitUsd: z.number().min(0).nullable().default(null),
  monthlyLimitUsd: z.number().min(0).nullable().default(null),

  timezone: z.string().default('UTC'),
  locale: z.enum(['de', 'en']).default('en'),
})

export type Settings = z.infer<typeof settingsSchema>

/** Keys whose values are encrypted at rest and never returned to a client. */
export const SECRET_SETTING_KEYS = ['runpodApiKey', 'huggingfaceToken', 'notifyWebhookUrl'] as const
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number]

/** The redacted shape the API actually returns. */
export type PublicSettings = Omit<Settings, SecretSettingKey> & {
  [K in SecretSettingKey as `has${Capitalize<K>}`]: boolean
}

/**
 * A partial update. Written out rather than `Partial<Settings>` because with
 * `exactOptionalPropertyTypes` those differ: an omitted key must be allowed to
 * arrive as an explicit `undefined` from JSON parsing.
 *
 * The distinction is load-bearing here: `undefined` means "leave this alone",
 * which lets the settings form submit without ever echoing back a secret it was
 * never shown. `null` means "clear it".
 */
export type SettingsPatch = { [K in keyof Settings]?: Settings[K] | undefined }

/**
 * Schema for a partial update, with **no defaults**.
 *
 * `settingsSchema.partial()` is not equivalent and must not be used here: zod
 * still applies each field's default, so parsing `{ locale: 'de' }` yields
 * `{ locale: 'de', runpodApiKey: null, huggingfaceToken: null, … }`. Since
 * `null` means "clear this", changing the language silently deleted the RunPod
 * key and the HuggingFace token. It presented as the app forgetting
 * credentials for no reason.
 *
 * Every field here is optional and default-free, so an absent key stays absent.
 */
export const settingsPatchSchema = z
  .object({
    runpodApiKey: z.string().min(1).nullable(),
    huggingfaceToken: z.string().min(1).nullable(),
    notifyWebhookUrl: z.string().url().nullable(),
    corsOrigins: z.array(z.string()),
    wakeWaitSeconds: z.number().int().min(0).max(900),
    maxConcurrentPods: z.number().int().min(1).max(10),
    dailyLimitUsd: z.number().min(0).nullable(),
    monthlyLimitUsd: z.number().min(0).nullable(),
    timezone: z.string(),
    locale: z.enum(['de', 'en']),
  })
  .partial()
