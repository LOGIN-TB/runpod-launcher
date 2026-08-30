import { LLAMACPP_PRESET, templateSchema } from '@runpod-launcher/shared'
import type { Db } from './db.js'

/**
 * Repairs templates written against a superseded engine preset.
 *
 * A template stores the argument string it was created with, so a fix to a
 * preset does not reach templates that already exist. Someone who created one
 * yesterday would go on hitting the same failure with no indication that
 * anything had changed, and no reason to suspect the template rather than the
 * model.
 *
 * Kept narrow: only the specific broken pattern is touched, and only for the
 * engine it applies to.
 */
export function migrateTemplates(db: Db, log: (message: string) => void): void {
  const rows = db.prepare('SELECT id, config FROM templates').all() as Array<{ id: string; config: string }>

  for (const row of rows) {
    const parsed = templateSchema.safeParse(JSON.parse(row.config))
    if (!parsed.success) continue
    const template = parsed.data

    // llama.cpp divides --ctx-size between parallel slots, so passing the
    // per-request window meant each request got window/slots. With the
    // defaults that was 16384/64 = 256 tokens, and every agent failed on its
    // first message.
    const sharesContext = template.engine === 'llamacpp'
    const usesPerRequestBudget = template.args?.includes('--ctx-size {{maxModelLen}}') ?? false
    if (!sharesContext || !usesPerRequestBudget) continue

    const repaired = {
      ...template,
      args: LLAMACPP_PRESET.chatArgs,
      maxConcurrentSequences: Math.min(
        template.maxConcurrentSequences ?? LLAMACPP_PRESET.defaultConcurrency,
        LLAMACPP_PRESET.defaultConcurrency,
      ),
    }

    db.prepare('UPDATE templates SET config = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(repaired),
      new Date().toISOString(),
      row.id,
    )
    log(
      `repaired template "${template.name}": llama.cpp was being given the per-request context as its total, ` +
        `leaving ${Math.floor((template.maxModelLen ?? 8192) / (template.maxConcurrentSequences ?? 1))} tokens per request`,
    )
  }
}
