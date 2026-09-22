// Print one JSON Schema node's property list. Path segments: `properties.X`,
// `items`, `additionalProperties`, `anyOf[i]`. Example:
//   node schema-path.mjs ir.schema.json properties.slides.items
import { readFileSync } from 'node:fs'

const [, , schemaPath, ...segments] = process.argv
let node = JSON.parse(readFileSync(schemaPath, 'utf8'))
const trail = []

for (const segment of segments) {
  const open = segment.indexOf('[')
  const key = open < 0 ? segment : segment.slice(0, open)
  node = node[key]
  if (node === undefined) {
    console.log(`MISSING at ${[...trail, key].join('.')}`)
    process.exit(1)
  }
  if (open >= 0) node = node[Number(segment.slice(open + 1, -1))]
  trail.push(segment)
  if (node === undefined) {
    console.log(`MISSING index at ${trail.join('.')}`)
    process.exit(1)
  }
}

const prefix = trail.join('.')
const props = node.properties ?? {}
const required = new Set(node.required ?? [])
console.log(`[${prefix}] type=${node.type} required=${JSON.stringify(node.required ?? [])}`)
for (const [key, value] of Object.entries(props)) {
  const parts = []
  const type = Array.isArray(value.type) ? value.type.join('|') : value.type
  if (type !== undefined) parts.push(type)
  if (value.const !== undefined) parts.push(`const=${JSON.stringify(value.const)}`)
  if (value.enum !== undefined) parts.push(`enum(${value.enum.length > 8 ? `${value.enum.slice(0, 8).join('|')}…` : value.enum.join('|')})`)
  if (value.$ref !== undefined) parts.push(value.$ref)
  if (value.items !== undefined) {
    const items = value.items
    parts.push(`items{${Array.isArray(items.type) ? items.type.join('|') : items.type}${items.properties ? ':' + Object.keys(items.properties).join('|') : ''}${items.enum ? ' enum(' + items.enum.slice(0, 12).join('|') + ')' : ''}}`)
  }
  if (value.anyOf !== undefined) parts.push(`anyOf{${value.anyOf.map((entry) => entry.$ref ?? entry.type ?? JSON.stringify(entry.const)).join('|')}}`)
  if (value.oneOf !== undefined) parts.push(`oneOf{${value.oneOf.map((entry) => entry.$ref ?? entry.type ?? JSON.stringify(entry.const)).join('|')}}`)
  console.log(`  ${required.has(key) ? '*' : ' '} ${key}: ${parts.join(' ') || JSON.stringify(value).slice(0, 120)}`)
}
if (Object.keys(props).length === 0) console.log('  (leaf)', JSON.stringify(node).slice(0, 600))
