// Summarize a JSON Schema's envelope without dumping megabytes into the
// transcript. Usage: node schema-summary.mjs <schema.json> [defName...]
import { readFileSync } from 'node:fs'

const [, , schemaPath, ...defNames] = process.argv
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'))
const defs = schema.$defs ?? schema.definitions ?? {}

console.log('title:', schema.title)
console.log('root required:', JSON.stringify(schema.required))
console.log('root props:', Object.keys(schema.properties ?? {}).join(', '))
console.log('defs count:', Object.keys(defs).length)

const describe = (name) => {
  const def = defs[name]
  if (def === undefined) {
    console.log(`\n[${name}] MISSING`)
    return
  }
  const props = def.properties ?? {}
  const required = new Set(def.required ?? [])
  console.log(`\n[${name}] required=${JSON.stringify(def.required ?? [])}`)
  for (const [key, value] of Object.entries(props)) {
    const parts = []
    if (value.type !== undefined) parts.push(Array.isArray(value.type) ? value.type.join('|') : value.type)
    if (value.enum !== undefined) parts.push(`enum(${value.enum.join('|')})`)
    if (value.const !== undefined) parts.push(`const(${JSON.stringify(value.const)})`)
    if (value.$ref !== undefined) parts.push(value.$ref)
    if (value.items !== undefined) parts.push(`items:${value.items.$ref ?? value.items.type ?? (value.items.anyOf ? 'anyOf' : '?')}`)
    if (value.anyOf !== undefined) parts.push(`anyOf:${value.anyOf.map((entry) => entry.$ref ?? entry.type ?? JSON.stringify(entry.const)).join('|')}`)
    if (value.oneOf !== undefined) parts.push(`oneOf:${value.oneOf.length}`)
    if (value.minimum !== undefined) parts.push(`min=${value.minimum}`)
    console.log(`  ${required.has(key) ? '*' : ' '} ${key}: ${parts.join(' ')}`)
  }
  if (Object.keys(props).length === 0) console.log('  (no properties)', JSON.stringify(def).slice(0, 400))
}

if (defNames.length === 0) {
  console.log('\ndef names:', Object.keys(defs).join(', '))
  describe(schema.title ?? '')
} else {
  for (const name of defNames) describe(name)
}
