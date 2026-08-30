/**
 * Turns a streamed OpenAI response back into a single non-streamed one.
 *
 * The gateway always asks the pod to stream, whatever the client asked for.
 * RunPod's HTTP proxy sits behind Cloudflare and gives up on a request that
 * produces nothing for 100 seconds — a long generation on a non-streaming call
 * therefore dies with an HTML error page instead of an answer. Streaming keeps
 * bytes moving, so the proxy stays out of the way; a client that wanted one
 * object gets one, reassembled here.
 */

interface Delta {
  role?: string
  content?: string
  reasoning_content?: string
  tool_calls?: Array<{
    index: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }>
}

interface Chunk {
  id?: string
  model?: string
  created?: number
  choices?: Array<{ index: number; delta?: Delta; finish_reason?: string | null }>
  usage?: Record<string, number> | null
}

export interface Reassembled {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      reasoning_content?: string
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    }
    finish_reason: string | null
  }>
  usage?: Record<string, number>
}

/** Collects a `text/event-stream` body into one completion object. */
export async function reassembleStream(body: ReadableStream<Uint8Array>): Promise<Reassembled> {
  const decoder = new TextDecoder()
  const reader = body.getReader()

  let buffer = ''
  let id = ''
  let model = ''
  let created = Math.floor(Date.now() / 1000)
  let usage: Record<string, number> | undefined
  let finishReason: string | null = null
  let role = 'assistant'
  let content = ''
  let reasoning = ''
  // Tool call arguments arrive a few characters at a time, keyed by index.
  const toolCalls = new Map<number, { id: string; type: string; name: string; arguments: string }>()

  const handle = (payload: string): void => {
    if (payload === '[DONE]') return
    let chunk: Chunk
    try {
      chunk = JSON.parse(payload) as Chunk
    } catch {
      return
    }

    id ||= chunk.id ?? ''
    model ||= chunk.model ?? ''
    if (chunk.created) created = chunk.created
    if (chunk.usage) usage = chunk.usage

    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) finishReason = choice.finish_reason
      const delta = choice.delta
      if (!delta) continue
      if (delta.role) role = delta.role
      if (delta.content) content += delta.content
      if (delta.reasoning_content) reasoning += delta.reasoning_content

      for (const call of delta.tool_calls ?? []) {
        const existing = toolCalls.get(call.index) ?? { id: '', type: 'function', name: '', arguments: '' }
        toolCalls.set(call.index, {
          id: call.id ?? existing.id,
          type: call.type ?? existing.type,
          name: call.function?.name ?? existing.name,
          // Concatenated, never replaced: this is the field that arrives in
          // fragments, and losing part of it produces invalid JSON arguments.
          arguments: existing.arguments + (call.function?.arguments ?? ''),
        })
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) handle(line.slice(5).trim())
      newline = buffer.indexOf('\n')
    }
  }
  // Whatever is left without a trailing newline.
  if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim())

  const calls = [...toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id,
      type: call.type,
      function: { name: call.name, arguments: call.arguments },
    }))

  return {
    id: id || 'chatcmpl-reassembled',
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role,
          // OpenAI sends null rather than an empty string when a tool call is
          // the whole answer, and some clients check for exactly that.
          content: content === '' && calls.length > 0 ? null : content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(calls.length > 0 ? { tool_calls: calls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    ...(usage ? { usage } : {}),
  }
}
