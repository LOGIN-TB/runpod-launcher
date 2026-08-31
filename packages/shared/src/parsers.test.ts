import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reasoningParserFor, toolCallParserFor } from './parsers.js'

/**
 * The decisive excerpt of `Qwen/Qwen3.8-27B-FP8`'s own chat template, copied
 * from the repository on 2026-08-31.
 *
 * Kept verbatim rather than paraphrased: the whole point is that this model's
 * format is not what its family name suggests, so an invented fixture would
 * test the guess instead of the model.
 */
const QWEN38_TEMPLATE = `{{- "\\n</tools>" }}
    {{- '\\n\\nIf you choose to call a function ONLY reply in the following format with NO suffix:\\n\\n<tool_call>\\n<function=example_function_name>\\n<parameter=example_parameter_1>\\nvalue_1\\n</parameter>\\n</function>\\n</tool_call>' }}
    {%- if enable_thinking %}{{- '<think>\\n' }}{%- endif %}`

/** Hermes style, as Qwen2.5 and the many templates copied from it emit it. */
const HERMES_TEMPLATE = `{{- "<tools>" }}
  {{- '<tool_call>\\n{"name": <function-name>, "arguments": <args-json-object>}\\n</tool_call>' }}`

test('a Qwen3.8 template asks for the XML parser, not the Hermes one', () => {
  // The bug this exists for. vLLM's own documentation lists Qwen2.5 and QwQ
  // under `hermes`, and reading that table would have produced a parser that
  // cannot read this model's calls at all — the client would then receive the
  // raw markup as the answer text.
  assert.equal(toolCallParserFor(QWEN38_TEMPLATE), 'qwen3_xml')
})

test('a Hermes-style template asks for the Hermes parser', () => {
  assert.equal(toolCallParserFor(HERMES_TEMPLATE), 'hermes')
})

test('a model that declares no tools gets no parser', () => {
  // Naming one anyway would advertise a capability the model was never trained
  // for, and every tool call would come back as prose.
  assert.equal(toolCallParserFor('{{- messages[0].content }}'), null)
  assert.equal(toolCallParserFor(null), null)
})

test('a thinking model gets a reasoning parser and a plain one does not', () => {
  // Without it the deliberation arrives inside the answer, which is what an
  // agent then reads out and pays to feed back in.
  assert.equal(reasoningParserFor(QWEN38_TEMPLATE), 'qwen3')
  assert.equal(reasoningParserFor(HERMES_TEMPLATE), null)
  assert.equal(reasoningParserFor(null), null)
})
