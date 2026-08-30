import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LLAMACPP_PRESET, templateSchema, VLLM_PRESET } from '@runpod-launcher/shared'
import { openDatabase } from './db.js'
import { migrateTemplates } from './migrate-templates.js'

const store = (template: Record<string, unknown>) => {
  const db = openDatabase(':memory:')
  const parsed = templateSchema.parse({
    id: 't1',
    name: 'x',
    image: 'img',
    gpuTypeId: 'NVIDIA A40',
    chatModel: { repoId: 'a/b' },
    lifecycleMode: 'stopResume',
    ...template,
  })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'x', JSON.stringify(parsed), now, now)
  return db
}

const read = (db: ReturnType<typeof store>) =>
  templateSchema.parse(JSON.parse((db.prepare('SELECT config FROM templates').get() as { config: string }).config))

test('a llama.cpp template built with the wrong context budget is repaired', () => {
  // Somebody who created a template yesterday would keep hitting "request
  // exceeds the available context size (256 tokens)" with no reason to suspect
  // the template rather than the model.
  const db = store({
    engine: 'llamacpp',
    maxModelLen: 16384,
    maxConcurrentSequences: 64,
    args: '-hf {{chatModel}} --ctx-size {{maxModelLen}} --parallel {{maxConcurrentSequences}}',
  })

  migrateTemplates(db, () => {})
  const repaired = read(db)

  assert.equal(repaired.args, LLAMACPP_PRESET.chatArgs)
  assert.equal(repaired.maxConcurrentSequences, 4, 'and the slot count is brought down to something that fits')
  assert.match(repaired.args!, /--ctx-size \{\{totalContext\}\}/)
})

test('a vLLM template is left alone — its budget is not shared', () => {
  const db = store({ engine: 'vllm', args: VLLM_PRESET.chatArgs, maxConcurrentSequences: 64 })
  migrateTemplates(db, () => {})
  const after = read(db)
  assert.equal(after.args, VLLM_PRESET.chatArgs)
  assert.equal(after.maxConcurrentSequences, 64)
})

test('an already-correct llama.cpp template is not touched', () => {
  const db = store({ engine: 'llamacpp', args: LLAMACPP_PRESET.chatArgs, maxConcurrentSequences: 8 })
  migrateTemplates(db, () => {})
  assert.equal(read(db).maxConcurrentSequences, 8, 'a deliberate choice above the default is kept')
})
