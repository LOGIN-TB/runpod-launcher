import type { Problem } from '@runpod-launcher/shared'
import type { MessageKey, Vars } from '@runpod-launcher/i18n'

/**
 * Turns a problem from the service into a sentence in the user's language.
 *
 * The service reports codes and numbers precisely so this step exists: it does
 * not know who is reading. Numbers arrive as numbers and are formatted here, so
 * German sees `18,1` and English `18.1`.
 */
export function describeProblem(
  problem: Problem,
  t: (key: MessageKey, vars?: Vars) => string,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  const params: Vars = {}
  for (const [key, value] of Object.entries(problem.params)) {
    params[key] = typeof value === 'number' ? formatNumber(value, { maximumFractionDigits: 1 }) : value
  }

  // One code has two phrasings: whether a second model is also on the card
  // changes the sentence, not just a number in it.
  const key: MessageKey =
    problem.code === 'does-not-fit' && Number(problem.params.otherGib ?? 0) > 0
      ? 'problem.does-not-fit-with-other'
      : (`problem.${problem.code}` as MessageKey)

  return t(key, params)
}
