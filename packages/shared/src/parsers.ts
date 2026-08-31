/**
 * Which vLLM parsers a model needs, read from its own chat template.
 *
 * vLLM refuses a request with `tool_choice: "auto"` unless it was started with
 * `--enable-auto-tool-choice` and a `--tool-call-parser`, and the parser has to
 * match the format the model actually emits. Guessing from the model's name
 * does not work: the docs list Qwen2.5 under `hermes`, but a Qwen3.8 chat
 * template emits XML — `<function=name><parameter=key>` — which `hermes` cannot
 * read. The template is the only honest source, and every repository ships it.
 *
 * Names verified against the parser registry of the pinned vLLM version
 * (v0.28.0, `vllm/tool_parsers/__init__.py`), not taken from prose.
 */

/** A model's tool-call format, or null when it declares no tools at all. */
export function toolCallParserFor(chatTemplate: string | null): string | null {
  if (!chatTemplate) return null
  // No tool section in the template means the model was not trained to call
  // anything, and naming a parser would only invent a capability.
  if (!chatTemplate.includes('<tool_call>')) return null

  // Qwen3's XML form. The parameters are named tags rather than a JSON object,
  // so a JSON parser reads the whole call as prose and the client sees the
  // markup in the answer text.
  if (chatTemplate.includes('<function=') && chatTemplate.includes('<parameter=')) return 'qwen3_xml'

  // Hermes style: a JSON object between the tags. Qwen2.5, QwQ and the many
  // models that copied that template.
  return 'hermes'
}

/**
 * The reasoning parser for a thinking model, or null.
 *
 * Without one the client receives the model's private deliberation inside the
 * answer text, which is both confusing to read and expensive to feed back in.
 */
export function reasoningParserFor(chatTemplate: string | null): string | null {
  if (!chatTemplate) return null
  if (!chatTemplate.includes('<think>')) return null
  return 'qwen3'
}
