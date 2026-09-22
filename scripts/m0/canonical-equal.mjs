// T1 semantic equality for two .pptx packages (plan v2 section 7.2): compare
// the part list, the relationship graph, XML with volatile metadata normalized,
// and binary parts by SHA-256. Zip entry timestamps and part order are ignored.
//
// Usage: node canonical-equal.mjs <a.pptx> <b.pptx> [--json]
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const JSZIP_DIR = process.env.DSH_JSZIP_DIR
if (!JSZIP_DIR) {
  console.error('set DSH_JSZIP_DIR to the directory containing the jszip package')
  process.exit(2)
}
const JSZip = require(JSZIP_DIR)

const [aPath, bPath] = process.argv.slice(2)
if (!bPath) {
  console.error('usage: node canonical-equal.mjs <a.pptx> <b.pptx> [--json]')
  process.exit(2)
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Drop the fields that legitimately carry wall-clock or producer metadata. */
const canonicalXml = (xml) =>
  xml
    .replace(/<dcterms:created[^>]*>[^<]*<\/dcterms:created>/g, '<dcterms:created/>')
    .replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/g, '<dcterms:modified/>')
    .replace(/<cp:revision>[^<]*<\/cp:revision>/g, '<cp:revision/>')
    .replace(/<TotalTime>[^<]*<\/TotalTime>/g, '<TotalTime/>')
    .replace(/>\s+</g, '><')
    .trim()

const describe = async (path) => {
  const zip = await JSZip.loadAsync(readFileSync(resolve(path)))
  const parts = new Map()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const buffer = await entry.async('nodebuffer')
    const isXml = /\.(xml|rels)$/.test(name)
    parts.set(name, isXml ? canonicalXml(buffer.toString('utf8')) : sha256(buffer))
  }
  return parts
}

const a = await describe(aPath)
const b = await describe(bPath)
const differences = []
for (const name of new Set([...a.keys(), ...b.keys()])) {
  if (!a.has(name)) differences.push(`only in B: ${name}`)
  else if (!b.has(name)) differences.push(`only in A: ${name}`)
  else if (a.get(name) !== b.get(name)) differences.push(`differs: ${name}`)
}

const report = { a: resolve(aPath), b: resolve(bPath), equal: differences.length === 0, parts: a.size, differences }
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
else {
  console.log(`${report.equal ? 'SEMANTICALLY EQUAL' : 'SEMANTICALLY DIFFERENT'} (${report.parts} parts)`)
  for (const difference of differences.slice(0, 20)) console.log(`  ${difference}`)
}
process.exit(report.equal ? 0 : 1)