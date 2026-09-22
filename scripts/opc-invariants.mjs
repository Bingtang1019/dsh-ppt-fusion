// OPC package invariants for a .pptx: part census, relationship integrity,
// content-type coverage, and the single-master product invariant (P1).
//
// Reused by M4's render gate, M8's acceptance run, and the golden fixtures.
//
// Usage:
//   node scripts/opc-invariants.mjs <deck.pptx> [--expect-slides N] [--single-master] [--json]
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const JSZIP_DIR = process.env.DSH_JSZIP_DIR
if (!JSZIP_DIR) {
  console.error('set DSH_JSZIP_DIR to the directory containing the jszip package')
  process.exit(2)
}
const JSZip = require(JSZIP_DIR)

const argv = process.argv.slice(2)
const deckPath = argv.find((argument) => !argument.startsWith('--'))
const expectSlides = Number(argv[argv.indexOf('--expect-slides') + 1]) || 0
const wantSingleMaster = argv.includes('--single-master')
const asJson = argv.includes('--json')
if (deckPath === undefined) {
  console.error('usage: node opc-invariants.mjs <deck.pptx> [--expect-slides N] [--single-master] [--json]')
  process.exit(2)
}

const zip = await JSZip.loadAsync(readFileSync(resolve(deckPath)))
const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
const has = (name) => names.includes(name)
const readText = async (name) => (has(name) ? zip.file(name).async('string') : null)

const findings = []
const add = (level, rule, message) => findings.push({ level, rule, message })

// --- part census -----------------------------------------------------------
const census = {
  slides: names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
  slideMasters: names.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name)).length,
  slideLayouts: names.filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name)).length,
  notesSlides: names.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).length,
  themes: names.filter((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name)).length,
  charts: names.filter((name) => /^ppt\/charts\/.*\.xml$/.test(name)).length,
  embeddings: names.filter((name) => name.startsWith('ppt/embeddings/')).length,
  media: names.filter((name) => name.startsWith('ppt/media/')).length,
  parts: names.length,
}

// --- content types ---------------------------------------------------------
const contentTypes = await readText('[Content_Types].xml')
if (contentTypes === null) {
  add('error', 'content-types', 'missing [Content_Types].xml')
} else {
  const defaults = new Set([...contentTypes.matchAll(/<Default\s+Extension="([^"]+)"/g)].map((match) => match[1].toLowerCase()))
  const overrides = new Set([...contentTypes.matchAll(/<Override\s+PartName="([^"]+)"/g)].map((match) => match[1].replace(/^\//, '')))
  for (const name of names) {
    if (name === '[Content_Types].xml') continue
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    if (!defaults.has(extension) && !overrides.has(name)) {
      add('error', 'content-types', `part has no default extension or override: ${name}`)
    }
  }
}

// --- relationships ---------------------------------------------------------
const relsParts = names.filter((name) => name.endsWith('.rels'))
const danglingTargets = []
const duplicateIds = []
const externalTypes = []
for (const relsName of relsParts) {
  const xml = await readText(relsName)
  const ids = new Set()
  const baseDir = relsName.replace(/_rels\/[^/]+$/, '')
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1]
    const id = attr('Id')
    const target = attr('Target')
    const mode = attr('TargetMode')
    if (ids.has(id)) duplicateIds.push(`${relsName}#${id}`)
    ids.add(id)
    if (mode === 'External') {
      externalTypes.push(`${relsName}#${id}`)
      continue
    }
    const joined = target.startsWith('/')
      ? target.slice(1)
      : new URL(target, `file:///${baseDir}`).pathname.replace(/^\//, '')
    if (!has(joined)) danglingTargets.push(`${relsName} -> ${target}`)
  }
}
if (danglingTargets.length > 0) add('error', 'relationships', `dangling internal targets (${danglingTargets.length}): ${danglingTargets.slice(0, 5).join('; ')}`)
if (duplicateIds.length > 0) add('error', 'relationships', `duplicate relationship ids: ${duplicateIds.join('; ')}`)
if (externalTypes.length > 0) add('warning', 'relationships', `external targets present: ${externalTypes.length}`)

// --- presentation wiring ---------------------------------------------------
const presentationRels = await readText('ppt/_rels/presentation.xml.rels')
if (presentationRels === null) {
  add('error', 'presentation', 'missing ppt/_rels/presentation.xml.rels')
} else {
  const rows = [...presentationRels.matchAll(/<Relationship\b[^>]*\/?>/g)].map((match) => ({
    id: /Id="([^"]*)"/.exec(match[0])?.[1],
    type: /Type="([^"]*)"/.exec(match[0])?.[1] ?? '',
    target: /Target="([^"]*)"/.exec(match[0])?.[1],
  }))
  const slideRels = rows.filter((row) => row.type.endsWith('/slide'))
  if (slideRels.length !== census.slides) {
    add('error', 'presentation', `presentation.xml.rels lists ${slideRels.length} slide rels but the package holds ${census.slides} slide parts`)
  }
  if (expectSlides > 0 && census.slides !== expectSlides) {
    add('error', 'presentation', `expected ${expectSlides} slides, found ${census.slides}`)
  }
  const masterRels = rows.filter((row) => row.type.endsWith('/slideMaster'))
  if (masterRels.length !== census.slideMasters) {
    add('error', 'presentation', `presentation.xml.rels lists ${masterRels.length} slideMaster rels but the package holds ${census.slideMasters} masters`)
  }
}

// --- every slide points at a layout below the single master ----------------
const layoutToMaster = new Map()
for (const name of names.filter((entry) => /^ppt\/slideLayouts\/_rels\/slideLayout\d+\.xml\.rels$/.test(entry))) {
  const xml = await readText(name)
  const target = /Target="([^"]+)"/.exec(xml)?.[1]
  const layout = name.replace('_rels/', '').replace(/\.rels$/, '')
  layoutToMaster.set(layout, target?.replace('../', '') ?? null)
}
const layoutOwners = new Set([...layoutToMaster.values()].filter(Boolean))
if (wantSingleMaster && census.slideMasters !== 1) {
  add('error', 'P1-single-master', `expected exactly 1 slideMaster part, found ${census.slideMasters}`)
}
if (layoutOwners.size > 1) {
  add('error', 'P1-single-master', `slide layouts reference ${layoutOwners.size} different masters: ${[...layoutOwners].join(', ')}`)
}

const errors = findings.filter((finding) => finding.level === 'error')
const report = {
  deck: resolve(deckPath),
  ok: errors.length === 0,
  census,
  findings,
}
if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`${report.ok ? 'OK  ' : 'FAIL'} ${report.deck}`)
  console.log(`     parts=${census.parts} slides=${census.slides} masters=${census.slideMasters} layouts=${census.slideLayouts} themes=${census.themes} charts=${census.charts} embeddings=${census.embeddings}`)
  for (const finding of findings) console.log(`     [${finding.level}] ${finding.rule}: ${finding.message}`)
}
process.exit(report.ok ? 0 : 1)
