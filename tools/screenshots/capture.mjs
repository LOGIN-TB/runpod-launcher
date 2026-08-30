#!/usr/bin/env node
/**
 * Generates the screenshots the in-app help uses.
 *
 * Every image of our own interface is produced here rather than taken by hand.
 * Hand-made screenshots are wrong two changes later, and a guide illustrated
 * with a version that no longer exists is worse than one with no pictures — it
 * actively misleads.
 *
 * Runs against a throwaway service seeded with fixed data, so the images are
 * identical between runs and safe to publish: no real keys, no real pod ids.
 *
 * Usage: node tools/screenshots/capture.mjs [--ui http://localhost:5173] [--service http://localhost:8080]
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(here, '../../docs/screenshots')

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const UI = arg('ui', 'http://localhost:5173')
const SERVICE = arg('service', 'http://localhost:8080')
const TOKEN = process.env.DEVICE_TOKEN

if (!TOKEN) {
  console.error('DEVICE_TOKEN is required: pair against the throwaway service first.')
  process.exit(1)
}

/** Every screen, in both languages and both colour schemes. */
const SCREENS = [
  { name: 'overview', nav: 0 },
  { name: 'templates', nav: 1 },
  { name: 'clients', nav: 2 },
  { name: 'settings', nav: 3 },
  { name: 'help', nav: 4 },
]
const LOCALES = ['en', 'de']
const SCHEMES = ['light', 'dark']

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const shots = []

for (const locale of LOCALES) {
  for (const colorScheme of SCHEMES) {
    const context = await browser.newContext({
      viewport: { width: 1100, height: 760 },
      deviceScaleFactor: 2,
      colorScheme,
      // Pretend the clock is fixed, so a screenshot does not differ from the
      // last one only by the minute it was taken.
      timezoneId: 'Europe/Berlin',
    })

    await context.addInitScript(
      ([token, service, lang]) => {
        localStorage.setItem('launcher.connection', JSON.stringify({ baseUrl: service, token }))
        localStorage.setItem('launcher.locale', lang)
      },
      [TOKEN, SERVICE, locale],
    )

    const page = await context.newPage()
    await page.goto(UI, { waitUntil: 'networkidle' })

    for (const screen of SCREENS) {
      const buttons = page.locator('nav.sidebar button.nav-item')
      await buttons.nth(screen.nav).click()
      // Let the screen's own fetches settle, so nothing is caught mid-skeleton.
      await page.waitForTimeout(900)

      const file = `${screen.name}-${locale}-${colorScheme}.png`
      await page.screenshot({ path: resolve(OUT, file) })
      shots.push(file)
    }

    await context.close()
  }
}

await browser.close()

// An index the help can read, so adding a screen does not mean editing a list
// by hand in two places.
writeFileSync(
  resolve(OUT, 'index.json'),
  `${JSON.stringify({ generatedFrom: UI, screens: SCREENS.map((s) => s.name), locales: LOCALES, schemes: SCHEMES, files: shots }, null, 2)}\n`,
)

console.log(`Wrote ${shots.length} screenshots to ${OUT}`)
