import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsPatchSchema, settingsSchema } from '@runpod-launcher/shared'
import { openDatabase } from './db.js'
import { loadOrCreateMasterKey } from './crypto.js'
import { SettingsStore } from './settings.js'

const store = (): SettingsStore => {
  const key = loadOrCreateMasterKey(join(mkdtempSync(join(tmpdir(), 'settings-')), 'master.key'))
  return new SettingsStore(openDatabase(':memory:'), key)
}

test('changing one setting does not wipe the others', () => {
  // The bug this guards: settingsSchema.partial() still applies every field's
  // default, so a PATCH of { locale } arrived as { locale, runpodApiKey: null,
  // … } — and null means "clear it". Switching language deleted the RunPod key.
  const settings = store()
  settings.update({ runpodApiKey: 'rpa_secret', huggingfaceToken: 'hf_secret' })

  const patch = settingsPatchSchema.parse({ locale: 'de' })
  settings.update(patch)

  assert.equal(settings.secret('runpodApiKey'), 'rpa_secret')
  assert.equal(settings.secret('huggingfaceToken'), 'hf_secret')
  assert.equal(settings.read().locale, 'de')
})

test('the patch schema keeps absent keys absent', () => {
  assert.deepEqual(settingsPatchSchema.parse({ wakeWaitSeconds: 20 }), { wakeWaitSeconds: 20 })
  // Left here as the reason the patch schema exists at all.
  assert.ok('runpodApiKey' in settingsSchema.partial().parse({ wakeWaitSeconds: 20 }))
})

test('an explicit null still clears a secret', () => {
  const settings = store()
  settings.update({ runpodApiKey: 'rpa_secret' })
  settings.update(settingsPatchSchema.parse({ runpodApiKey: null }))
  assert.equal(settings.secret('runpodApiKey'), null)
})

test('secrets never appear in what the API returns', () => {
  const settings = store()
  settings.update({ runpodApiKey: 'rpa_secret', notifyWebhookUrl: 'https://example.com/hook' })
  const published = settings.readPublic()

  assert.equal(JSON.stringify(published).includes('rpa_secret'), false)
  assert.equal(JSON.stringify(published).includes('example.com'), false)
  assert.equal(published.hasRunpodApiKey, true)
  assert.equal(published.hasNotifyWebhookUrl, true)
  assert.equal(published.hasHuggingfaceToken, false)
})
