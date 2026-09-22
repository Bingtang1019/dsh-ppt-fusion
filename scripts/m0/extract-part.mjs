// Extract one part from an OPC package to a file (debug helper).
// Usage: node extract-part.mjs <package> <partName> <outFile>
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const JSZIP_DIR = process.env.DSH_JSZIP_DIR
if (!JSZIP_DIR) {
  console.error('set DSH_JSZIP_DIR to the directory containing the jszip package')
  process.exit(2)
}
const JSZip = require(JSZIP_DIR)

const [packagePath, partName, outFile] = process.argv.slice(2)
if (!outFile) {
  console.error('usage: node extract-part.mjs <package> <partName> <outFile>')
  process.exit(2)
}
const zip = await JSZip.loadAsync(readFileSync(resolve(packagePath)))
const entry = zip.file(partName)
if (entry === null) {
  console.error(`part not found: ${partName}`)
  process.exit(1)
}
writeFileSync(resolve(outFile), await entry.async('nodebuffer'))
console.log(`${partName} -> ${resolve(outFile)}`)