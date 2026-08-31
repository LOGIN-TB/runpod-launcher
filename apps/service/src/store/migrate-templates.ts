import { LLAMACPP_PRESET, templateSchema, VLLM_PRESET, type Template } from '@runpod-launcher/shared'
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
 * Kept narrow: each repair looks for one specific broken pattern, on the one
 * engine it applies to, and says what it changed.
 */
export function migrateTemplates(db: Db, log: (message: string) => void): void {
  const rows = db.prepare('SELECT id, config FROM templates').all() as Array<{ id: string; config: string }>

  for (const row of rows) {
    const parsed = templateSchema.safeParse(JSON.parse(row.config))
    if (!parsed.success) continue

    let template = parsed.data
    const notes: string[] = []

    for (const repair of REPAIRS) {
      const patch = repair(template)
      if (!patch) continue
      template = { ...template, ...patch.changes }
      notes.push(patch.note)
    }

    if (notes.length === 0) continue

    db.prepare('UPDATE templates SET config = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(template),
      new Date().toISOString(),
      row.id,
    )
    for (const note of notes) log(`repaired template "${template.name}": ${note}`)
  }
}

interface Repair {
  changes: Partial<Template>
  note: string
}

const REPAIRS: ReadonlyArray<(template: Template) => Repair | null> = [
  /**
   * llama.cpp divides `--ctx-size` between parallel slots, so passing the
   * per-request window meant each request got window/slots. With the defaults
   * that was 16384/64 = 256 tokens, and every agent failed on its first
   * message with "request exceeds the available context size".
   */
  (template) => {
    if (template.engine !== 'llamacpp') return null
    if (!template.args?.includes('--ctx-size {{maxModelLen}}')) return null
    return {
      changes: {
        args: LLAMACPP_PRESET.chatArgs,
        maxConcurrentSequences: Math.min(
          template.maxConcurrentSequences ?? LLAMACPP_PRESET.defaultConcurrency,
          LLAMACPP_PRESET.defaultConcurrency,
        ),
      },
      note:
        'llama.cpp was being given the per-request context as its total, leaving ' +
        `${Math.floor((template.maxModelLen ?? 8192) / (template.maxConcurrentSequences ?? 1))} tokens per request`,
    }
  },

  /**
   * vLLM refuses any request carrying tools unless it was started with
   * `--enable-auto-tool-choice` and a `--tool-call-parser`. Templates written
   * before those flags existed cannot express them at all, so the pod starts
   * fine and then rejects the agent's first message with HTTP 400.
   *
   * Only the placeholders are added here. They render to nothing until a parser
   * is chosen, and which parser is right depends on the format the model emits
   * — a fact that lives in the model's chat template, not in our records.
   */
  (template) => {
    if (template.engine !== 'vllm' || template.chatModel === null) return null
    if (template.args === undefined || template.args.includes('{{toolFlags}}')) return null
    return {
      changes: { args: VLLM_PRESET.chatArgs },
      note:
        'vLLM could not be told about tool calls at all, so every request carrying tools was rejected. ' +
        'Open the template and pick its chat model again to detect the parser it needs.',
    }
  },
]
