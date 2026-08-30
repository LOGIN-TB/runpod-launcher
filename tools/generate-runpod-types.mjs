#!/usr/bin/env node
/**
 * Generates TypeScript types for the RunPod REST API v2 from the live OpenAPI
 * specification. Run with `npm run gen:runpod`.
 *
 * We deliberately generate rather than hand-write these: RunPod v1 retires on
 * 2026-11-15 and v2 is still evolving, so the spec is the single source of truth
 * for endpoint paths and payload shapes.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SPEC_URL = 'https://api.runpod.io/v2/openapi.json'
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/shared/src/runpod/generated.ts')

/**
 * Entry-point schemas. Everything they reference is pulled in transitively, so
 * this list only needs the types the service actually names.
 */
const ROOTS = [
  'Pod', 'CreatePodRequest', 'UpdatePodRequest', 'PodAction',
  'NetworkVolume', 'CreateNetworkVolumeRequest',
  'Template', 'CreateTemplateRequest',
  'GpuType', 'DataCenter',
  'PodBillingRecord',
]

const spec = await fetch(SPEC_URL).then((r) => {
  if (!r.ok) throw new Error(`Spec fetch failed: ${r.status} ${r.statusText}`)
  return r.json()
})

const schemas = spec.components?.schemas ?? {}
const refName = (ref) => ref.split('/').pop()

/** Renders one JSON-Schema node as a TypeScript type expression. */
function render(node, depth = 0) {
  if (!node) return 'unknown'
  if (node.$ref) return refName(node.$ref)
  if (node.allOf) return node.allOf.map((n) => render(n, depth)).join(' & ')
  if (node.oneOf) return node.oneOf.map((n) => render(n, depth)).join(' | ')
  if (node.anyOf) return node.anyOf.map((n) => render(n, depth)).join(' | ')
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(' | ')

  const types = Array.isArray(node.type) ? node.type : [node.type]
  const parts = types.map((t) => {
    switch (t) {
      case 'string': return 'string'
      case 'number':
      case 'integer': return 'number'
      case 'boolean': return 'boolean'
      case 'null': return 'null'
      case 'array': return `Array<${render(node.items, depth + 1)}>`
      case 'object': {
        if (node.additionalProperties && !node.properties) {
          return `Record<string, ${render(node.additionalProperties, depth + 1)}>`
        }
        return renderObject(node, depth)
      }
      default: return node.properties ? renderObject(node, depth) : 'unknown'
    }
  })
  return parts.join(' | ')
}

function renderObject(node, depth) {
  const props = Object.entries(node.properties ?? {})
  if (props.length === 0) return 'Record<string, unknown>'
  const required = new Set(node.required ?? [])
  const pad = '  '.repeat(depth + 1)
  const body = props
    .map(([key, value]) => {
      const doc = (value.description ?? '').split('\n')[0].trim()
      const comment = doc ? `${pad}/** ${doc} */\n` : ''
      const optional = required.has(key) ? '' : '?'
      return `${comment}${pad}${JSON.stringify(key)}${optional}: ${render(value, depth + 1)}`
    })
    .join('\n')
  return `{\n${body}\n${'  '.repeat(depth)}}`
}

/** Walks $refs from ROOTS so referenced types are emitted too. */
function collect(roots) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length) {
    const name = queue.pop()
    if (seen.has(name)) continue
    if (!schemas[name]) {
      console.warn(`warning: spec does not define '${name}'`)
      continue
    }
    seen.add(name)
    const refs = JSON.stringify(schemas[name]).matchAll(new RegExp('"#/components/schemas/([^"]+)"', 'g'))
    for (const ref of refs) {
      queue.push(ref[1])
    }
  }
  return [...seen].sort()
}

const EXPORTED = collect(ROOTS)

const header = `// GENERATED FILE — do not edit by hand.
// Source: ${SPEC_URL}
// Regenerate with: npm run gen:runpod
// Spec version: ${spec.info?.version ?? 'unknown'}
/* eslint-disable */
`

const body = EXPORTED
  .map((name) => {
    const doc = (schemas[name].description ?? '').split('\n')[0].trim()
    const comment = doc ? `/** ${doc} */\n` : ''
    return `${comment}export type ${name} = ${render(schemas[name])}\n`
  })
  .join('\n')

const paths = Object.entries(spec.paths ?? {})
  .flatMap(([path, ops]) =>
    Object.entries(ops)
      .filter(([method]) => ['get', 'post', 'patch', 'put', 'delete'].includes(method))
      .map(([method, op]) => `  ${op.operationId}: { method: '${method.toUpperCase()}', path: '${path}' },`),
  )
  .join('\n')

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${header}\n${body}\n/** Every operation the spec exposes, as method + path. */\nexport const OPERATIONS = {\n${paths}\n} as const\n`)

console.log(`Wrote ${OUT}`)
console.log(`  ${EXPORTED.length} types, ${paths.split('\n').length} operations`)
