#!/usr/bin/env node
/**
 * Moves the release number, in every place that carries one.
 *
 * The version lives in seven files — the root manifest, four workspaces, the
 * Tauri config and the Rust crate — and the installers, the container tag and
 * the "about" line all read a different one of them. Bumping by hand means
 * they drift, and a drifted version is the kind of bug that only shows up in a
 * released artefact, where it cannot be fixed quietly.
 *
 * Usage:  node tools/bump-version.mjs [patch|minor|major|X.Y.Z]
 *
 * Prints the new version to stdout, so a workflow can tag with it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The root manifest is the one that decides; everything else follows it. */
const MANIFESTS = [
  'package.json',
  'packages/shared/package.json',
  'packages/i18n/package.json',
  'apps/service/package.json',
  'apps/desktop/package.json',
  'apps/desktop/src-tauri/tauri.conf.json',
]
const CARGO = 'apps/desktop/src-tauri/Cargo.toml'

const readJson = (file) => JSON.parse(readFileSync(join(root, file), 'utf8'))

const current = readJson('package.json').version
const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
if (!parsed) throw new Error(`The root version is not a plain X.Y.Z: ${current}`)
const [major, minor, patch] = parsed.slice(1).map(Number)

const asked = process.argv[2] ?? 'patch'
const next =
  asked === 'major'
    ? `${major + 1}.0.0`
    : asked === 'minor'
      ? `${major}.${minor + 1}.0`
      : asked === 'patch'
        ? `${major}.${minor}.${patch + 1}`
        : asked

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  throw new Error(`Not a version and not a bump: ${asked}. Use patch, minor, major or X.Y.Z.`)
}

for (const file of MANIFESTS) {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  // Rewritten by hand rather than by re-serialising the parsed object: that
  // would reformat the whole file and bury the one line that changed.
  const updated = text.replace(/^(\s*"version":\s*)"[^"]+"/m, `$1"${next}"`)
  if (updated === text) throw new Error(`No version line found in ${file}`)
  writeFileSync(path, updated)
}

const cargoPath = join(root, CARGO)
const cargo = readFileSync(cargoPath, 'utf8')
// Anchored to the `[package]` section: a dependency's own version line must
// not be caught by this.
const cargoUpdated = cargo.replace(/^(version = )"[^"]+"/m, `$1"${next}"`)
if (cargoUpdated === cargo) throw new Error(`No version line found in ${CARGO}`)
writeFileSync(cargoPath, cargoUpdated)

process.stdout.write(next + '\n')
