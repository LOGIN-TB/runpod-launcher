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

test('a vLLM template written before tool support can express it afterwards', () => {
  // Seen live: the pod started, and the agent's first message came back as
  // HTTP 400 `"auto" tool choice requires --enable-auto-tool-choice and
  // --tool-call-parser to be set`. The template stored the argument string it
  // was created with, so it had no way to pass either flag.
  const db = openDatabase(':memory:')
  const stale = templateSchema.parse({
    id: 't1',
    name: 'QwenVllm',
    engine: 'vllm',
    image: VLLM_PRESET.image,
    gpuTypeId: 'NVIDIA L40S',
    chatModel: { repoId: 'Qwen/Qwen3.8-27B-FP8' },
    lifecycleMode: 'stopResume',
    // The preset as it read before the parser flags existed.
    args:
      '{{chatModel}} --port 8000 --host 0.0.0.0 --api-key {{apiKey}}' +
      ' --max-model-len {{maxModelLen}} --gpu-memory-utilization {{chatGpuFraction}}' +
      ' --max-num-seqs {{maxConcurrentSequences}}',
  })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(stale.id, stale.name, JSON.stringify(stale), now, now)

  const notes: string[] = []
  migrateTemplates(db, (message) => notes.push(message))

  const after = templateSchema.parse(
    JSON.parse((db.prepare('SELECT config FROM templates WHERE id = ?').get('t1') as { config: string }).config),
  )
  assert.match(after.args ?? '', /\{\{toolFlags\}\}/)
  assert.match(after.args ?? '', /\{\{reasoningFlags\}\}/)
  assert.equal(notes.length, 1)
  assert.match(notes[0]!, /pick its chat model again/)
})

test('a vLLM template that already carries the flags is left alone', () => {
  const db = openDatabase(':memory:')
  const current = templateSchema.parse({
    id: 't1',
    name: 'fine',
    engine: 'vllm',
    image: VLLM_PRESET.image,
    gpuTypeId: 'NVIDIA L40S',
    chatModel: { repoId: 'Qwen/Qwen3.8-27B-FP8' },
    lifecycleMode: 'stopResume',
    args: VLLM_PRESET.chatArgs,
    toolCallParser: 'qwen3_xml',
  })
  const now = new Date().toISOString()
  db.prepare('INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(current.id, current.name, JSON.stringify(current), now, now)

  const notes: string[] = []
  migrateTemplates(db, (message) => notes.push(message))
  assert.deepEqual(notes, [], 'nothing to repair, so nothing is said')
})
