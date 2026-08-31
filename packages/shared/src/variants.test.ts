import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chooseVariant } from './variants.js'

/** As `unsloth`-style GGUF repositories offer them: many builds, one repo. */
const OFFERED = [{ variant: 'Q8_0' }, { variant: 'Q6_K' }, { variant: 'Uncensored-Q4_K_M' }]

test('a saved build is kept when the repository still offers it', () => {
  // The reported bug: reopening a template for editing showed the first entry
  // rather than the Q4 that had been chosen, and saving changed the model.
  assert.equal(chooseVariant('Uncensored-Q4_K_M', OFFERED, 'Q8_0'), 'Uncensored-Q4_K_M')
  assert.equal(chooseVariant('Q6_K', OFFERED, 'Q8_0'), 'Q6_K')
})

test('with nothing saved, the default stands', () => {
  assert.equal(chooseVariant(null, OFFERED, 'Q8_0'), 'Q8_0')
})

test('a build the repository no longer has falls back instead of pretending', () => {
  // A value with no matching option does not render blank: the browser shows
  // the first option while the state holds the missing one, which is the same
  // silent substitution the fix exists to prevent.
  assert.equal(chooseVariant('Q2_K_removed', OFFERED, 'Q8_0'), 'Q8_0')
})

test('a repository with no builds to choose between keeps what it was given', () => {
  // Not GGUF: vLLM reads the repository as it is, and there is nothing to pick.
  assert.equal(chooseVariant('anything', undefined, null), 'anything')
  assert.equal(chooseVariant(null, undefined, null), null)
})

test('an empty build list falls back rather than keeping a stale name', () => {
  assert.equal(chooseVariant('gone', [], null), null)
})
