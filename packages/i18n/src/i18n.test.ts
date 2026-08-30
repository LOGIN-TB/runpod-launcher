import assert from 'node:assert/strict'
import { test } from 'node:test'
import { de, en, LOCALES, MESSAGES, resolveLocale, translate } from './index.js'

test('every locale carries exactly the reference keys', () => {
  const reference = Object.keys(en).sort()
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(MESSAGES[locale]).sort(), reference, `${locale} differs from the reference`)
  }
})

test('no message is left in English by accident in the German locale', () => {
  // Proper nouns and words that are genuinely identical in both languages.
  // Keep this list short: each entry is a translation that will never be
  // checked again, so anything added here should be obviously untranslatable.
  const allowed = new Set(['app.name', 'template.name', 'pods.title'])
  const identical = (Object.keys(en) as Array<keyof typeof en>).filter(
    (key) => !allowed.has(key) && en[key] === de[key],
  )
  assert.deepEqual(identical, [], 'these German strings are still the English text')
})

test('placeholders are filled, and unknown ones left visible', () => {
  assert.equal(translate('en', 'pod.costPerHour', { amount: '$0.99' }), '$0.99 per hour')
  assert.equal(translate('de', 'pod.costPerHour', { amount: '0,99 $' }), '0,99 $ pro Stunde')
  // A missing variable stays as {name} rather than becoming "undefined", so the
  // gap is obvious in a screenshot instead of reading like a real value.
  assert.match(translate('en', 'pod.costPerHour', {}), /\{amount\}/)
})

test('every placeholder in English also exists in German', () => {
  const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    assert.deepEqual(
      placeholders(de[key]),
      placeholders(en[key]),
      `${key}: placeholders differ between locales`,
    )
  }
})

test('the system language is matched, with English as the fallback', () => {
  assert.equal(resolveLocale(['de-DE', 'en-US']), 'de')
  assert.equal(resolveLocale(['de']), 'de')
  assert.equal(resolveLocale(['fr-FR', 'de-AT']), 'de')
  assert.equal(resolveLocale(['fr-FR']), 'en')
  assert.equal(resolveLocale([]), 'en')
})

test('every problem code the service can emit has a message in both locales', () => {
  // The service returns codes, not sentences, so an unmapped code would render
  // as the raw code in the interface. Listing them here keeps the two in step.
  const codes = [
    'format-engine-mismatch',
    'fp8-unsupported-gpu',
    'does-not-fit',
    'does-not-fit-with-other',
    'tight-headroom',
    'repo-gated',
    'repo-missing',
    'hub-error',
  ]
  for (const code of codes) {
    const key = `problem.${code}` as keyof typeof en
    assert.ok(en[key], `English is missing problem.${code}`)
    assert.ok(de[key], `German is missing problem.${code}`)
  }
})

test('every reason the scheduler can give has a message in both locales', () => {
  // Same contract as the problem codes: the service reports a code and the app
  // phrases it, so an unmapped reason would surface as raw kebab-case.
  const reasons = [
    'inside-schedule',
    'outside-schedule',
    'idle-timeout',
    'max-runtime',
    'daily-limit',
    'monthly-limit',
    'schedule-disabled',
    'already-correct',
    'starting',
    'idle-until-requested',
  ]
  for (const reason of reasons) {
    const key = `schedule.reason.${reason}` as keyof typeof en
    assert.ok(en[key], `English is missing schedule.reason.${reason}`)
    assert.ok(de[key], `German is missing schedule.reason.${reason}`)
  }
})
