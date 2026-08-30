import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reassembleStream } from './reassemble.js'

const stream = (lines: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
}

const chunk = (delta: unknown, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    model: 'test-model',
    created: 1_700_000_000,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

test('a streamed answer becomes the single object a client asked for', async () => {
  const result = await reassembleStream(
    stream([
      chunk({ role: 'assistant', content: 'Hallo' }),
      chunk({ content: ', Welt' }),
      chunk({}, 'stop'),
      'data: [DONE]\n\n',
    ]),
  )

  assert.equal(result.object, 'chat.completion')
  assert.equal(result.choices[0]!.message.content, 'Hallo, Welt')
  assert.equal(result.choices[0]!.finish_reason, 'stop')
  assert.equal(result.model, 'test-model')
})

test('tool call arguments are concatenated, never replaced', async () => {
  // This is the field that arrives a few characters at a time. Taking the last
  // fragment instead of joining them yields invalid JSON — which is exactly
  // what a "truncated tool call" looks like from the client's side.
  const result = await reassembleStream(
    stream([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Ber' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'lin"}' } }] }),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ]),
  )

  const call = result.choices[0]!.message.tool_calls![0]!
  assert.equal(call.function.name, 'get_weather')
  assert.equal(call.function.arguments, '{"city":"Berlin"}')
  assert.deepEqual(JSON.parse(call.function.arguments), { city: 'Berlin' })
  assert.equal(result.choices[0]!.message.content, null, 'null, not "", when a tool call is the whole answer')
})

test('several tool calls keep their own arguments', async () => {
  const result = await reassembleStream(
    stream([
      chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'one', arguments: '{"x":' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'two', arguments: '{"y":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '1}' } }] }),
      chunk({ tool_calls: [{ index: 1, function: { arguments: '2}' } }] }),
      'data: [DONE]\n\n',
    ]),
  )

  const calls = result.choices[0]!.message.tool_calls!
  assert.equal(calls.length, 2)
  assert.equal(calls[0]!.function.arguments, '{"x":1}')
  assert.equal(calls[1]!.function.arguments, '{"y":2}')
})

test('a thinking model keeps its reasoning out of the answer', async () => {
  const result = await reassembleStream(
    stream([
      chunk({ reasoning_content: 'Der Nutzer fragt ' }),
      chunk({ reasoning_content: 'nach dem Wetter.' }),
      chunk({ content: 'In Berlin regnet es.' }),
      chunk({}, 'stop'),
    ]),
  )
  assert.equal(result.choices[0]!.message.content, 'In Berlin regnet es.')
  assert.equal(result.choices[0]!.message.reasoning_content, 'Der Nutzer fragt nach dem Wetter.')
})

test('chunks split across network reads are still parsed', async () => {
  // A stream arrives in whatever pieces the socket delivers, not in whole
  // lines. Parsing per read rather than per line loses data.
  const whole = chunk({ role: 'assistant', content: 'geteilt' })
  const result = await reassembleStream(
    stream([whole.slice(0, 20), whole.slice(20), chunk({}, 'stop'), 'data: [DONE]\n\n']),
  )
  assert.equal(result.choices[0]!.message.content, 'geteilt')
})

test('usage is carried through when the engine reports it', async () => {
  const result = await reassembleStream(
    stream([
      chunk({ content: 'x' }),
      `data: ${JSON.stringify({ id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`,
      'data: [DONE]\n\n',
    ]),
  )
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 2 })
})
