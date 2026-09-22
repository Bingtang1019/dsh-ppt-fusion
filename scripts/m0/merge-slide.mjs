// M0.D prototype, v2 scope: replace one slide part of a pptwise deck with a
// ppt-master slide part, import that slide's non-layout relationship closure
// (charts, embedded workbooks, media, notes slides), and remap the slide's
// layout relationship onto the receiving deck's own layout so the result keeps
// exactly one slideMaster (plan v2 section 3.5, invariant P1).
//
// Dropped on purpose: the deep slide's slideLayout, slideMaster and theme. Deep
// pages are absolutely positioned shapes, so the remapped base layout only
// supplies background and placeholder behaviour; the deep page's palette comes
// from the theme bridge, not from an imported theme part.
//
// Usage: node merge-slide.mjs <base.pptx> <deep.pptx> <baseSlideNo> <deepSlideNo> <out.pptx>
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

// jszip is resolved from the scratch profile's pnpm store: jszip 3.x requires
// its sibling setimmediate/pako/lie/readable-stream packages, which only resolve
// from inside that store directory. M1 makes jszip a real dependency.
const require = createRequire(import.meta.url)
const JSZIP_DIR = process.env.DSH_JSZIP_DIR
if (!JSZIP_DIR) {
  console.error('set DSH_JSZIP_DIR to the directory containing the jszip package')
  process.exit(2)
}
const JSZip = require(JSZIP_DIR)

const [basePath, deepPath, baseNo, deepNo, outPath] = process.argv.slice(2)
if (!outPath) {
  console.error('usage: node merge-slide.mjs <base.pptx> <deep.pptx> <baseSlideNo> <deepSlideNo> <out.pptx>')
  process.exit(2)
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const LAYOUT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout'

const base = await JSZip.loadAsync(readFileSync(resolve(basePath)))
const deep = await JSZip.loadAsync(readFileSync(resolve(deepPath)))
const baseNames = new Set(Object.keys(base.files).filter((name) => !base.files[name].dir))
const deepNames = new Set(Object.keys(deep.files).filter((name) => !deep.files[name].dir))

const slidePart = (no) => `ppt/slides/slide${no}.xml`
const relsPart = (part) => {
  const cut = part.lastIndexOf('/')
  return `${part.slice(0, cut)}/_rels/${part.slice(cut + 1)}.rels`
}
const dirname = (part) => part.slice(0, part.lastIndexOf('/'))
const basename = (part) => part.slice(part.lastIndexOf('/') + 1)
const readPart = async (zip, name) => {
  const entry = zip.file(name)
  if (entry === null) throw new Error(`missing part ${name}`)
  return entry.async('string')
}
const readBytes = async (zip, name) => {
  const entry = zip.file(name)
  if (entry === null) throw new Error(`missing part ${name}`)
  return entry.async('nodebuffer')
}

const parseRels = (xml) =>
  [...xml.matchAll(/<Relationship\b[^>]*\/?>/g)].map((match) => {
    const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1]
    return { id: attr('Id'), type: attr('Type'), target: attr('Target'), targetMode: attr('TargetMode') }
  })

/** Resolve a relationship target to a package part name. */
const resolveTarget = (fromPart, target) => {
  if (target.startsWith('/')) return target.slice(1)
  const from = dirname(fromPart).split('/')
  for (const segment of target.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') from.pop()
    else from.push(segment)
  }
  return from.join('/')
}

/** A package-relative target string that points from fromPart at toPart. */
const relativeTarget = (fromPart, toPart) => {
  const from = dirname(fromPart).split('/')
  const to = toPart.split('/')
  while (from.length > 0 && to.length > 0 && from[0] === to[0]) {
    from.shift()
    to.shift()
  }
  return [...from.map(() => '..'), ...to].join('/')
}

// Content types for closure parts the base deck cannot already type by extension.
const CONTENT_TYPE_BY_SUFFIX = [
  [/^ppt\/charts\/[^/]+\.xml$/, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml'],
  [/^ppt\/embeddings\/[^/]+\.xlsx$/, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  [/^ppt\/notesSlides\/[^/]+\.xml$/, 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml'],
  [/^ppt\/media\/[^/]+\.png$/, 'image/png'],
  [/^ppt\/media\/[^/]+\.jpe?g$/, 'image/jpeg'],
  [/^ppt\/media\/[^/]+\.gif$/, 'image/gif'],
  [/^ppt\/media\/[^/]+\.svg$/, 'image/svg+xml'],
  [/^ppt\/media\/[^/]+\.emf$/, 'image/x-emf'],
  [/^ppt\/media\/[^/]+\.wmf$/, 'image/x-wmf'],
]
const contentTypeFor = (part) => CONTENT_TYPE_BY_SUFFIX.find(([pattern]) => pattern.test(part))?.[1]

// ---------------------------------------------------------------------------
// 1. Collect the deep slide's closure, skipping the layout/master/theme branch.
// ---------------------------------------------------------------------------
const imported = new Map()
const assigned = new Set()

const assignName = (deepPart) => {
  const suffix = basename(deepPart)
  const stem = suffix.slice(0, suffix.lastIndexOf('.'))
  const extension = suffix.slice(suffix.lastIndexOf('.'))
  const prefix = stem.replace(/\d+$/, '')
  const directory = dirname(deepPart)
  let index = 1
  for (;;) {
    const candidate = `${directory}/${prefix}${index}${extension}`
    if (!baseNames.has(candidate) && !assigned.has(candidate)) return candidate
    index += 1
  }
}

const walk = async (deepPart, referrer) => {
  if (imported.has(deepPart) || baseNames.has(deepPart)) return
  if (!deepNames.has(deepPart)) throw new Error(`deep package is missing closure part ${deepPart} (from ${referrer})`)
  if (deepPart.startsWith('ppt/slideLayouts/') || deepPart.startsWith('ppt/slideMasters/') || deepPart.startsWith('ppt/theme/')) {
    throw new Error(`closure walk reached ${deepPart}; layout/master/theme must be dropped, not imported`)
  }
  const name = assignName(deepPart)
  imported.set(deepPart, name)
  assigned.add(name)
  const relsName = relsPart(deepPart)
  if (deepNames.has(relsName)) {
    for (const rel of parseRels(await readPart(deep, relsName))) {
      if (rel.targetMode === 'External') continue
      await walk(resolveTarget(deepPart, rel.target), `${deepPart}#${rel.id}`)
    }
  }
}

const baseSlide = slidePart(Number(baseNo))
const deepSlide = slidePart(Number(deepNo))
const baseSlideRels = parseRels(await readPart(base, relsPart(baseSlide)))
const deepSlideRels = parseRels(await readPart(deep, relsPart(deepSlide)))

const baseLayoutRel = baseSlideRels.find((rel) => rel.type === LAYOUT_REL)
if (baseLayoutRel === undefined) throw new Error('base slide has no slideLayout relationship')
const deepLayoutRel = deepSlideRels.find((rel) => rel.type === LAYOUT_REL)
if (deepLayoutRel === undefined) throw new Error('deep slide has no slideLayout relationship')

const carried = deepSlideRels.filter((rel) => rel.type !== LAYOUT_REL)

// ---------------------------------------------------------------------------
// 2. Import the carried closure.
// ---------------------------------------------------------------------------
for (const rel of carried) {
  if (rel.targetMode === 'External') continue
  await walk(resolveTarget(deepSlide, rel.target), `${deepSlide}#${rel.id}`)
}

// ---------------------------------------------------------------------------
// 3. Rewrite the imported parts' relationships around the new names.
// ---------------------------------------------------------------------------
const rewrittenRels = new Map()
for (const [deepPart, basePart] of imported) {
  const relsName = relsPart(deepPart)
  if (!deepNames.has(relsName)) continue
  const rows = parseRels(await readPart(deep, relsName)).map((rel) => {
    if (rel.targetMode === 'External') {
      return `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}" TargetMode="External"/>`
    }
    const targetDeepPart = resolveTarget(deepPart, rel.target)
    const targetBasePart = imported.get(targetDeepPart) ?? targetDeepPart
    return `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${relativeTarget(basePart, targetBasePart)}"/>`
  })
  rewrittenRels.set(relsPart(basePart), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${rows.join('')}</Relationships>\n`)
}

// The slide keeps the deep relationship ids so its own XML needs no rewriting;
// the layout relationship takes the deep layout id unless a kept rel already
// uses it.
const usedIds = new Set(carried.map((rel) => rel.id))
let layoutId = deepLayoutRel.id
for (let index = 1; usedIds.has(layoutId); index += 1) layoutId = `rId${100 + index}`
const slideRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">` +
  `<Relationship Id="${layoutId}" Type="${baseLayoutRel.type}" Target="${baseLayoutRel.target}"/>` +
  carried
    .map((rel) => {
      if (rel.targetMode === 'External') {
        return `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}" TargetMode="External"/>`
      }
      const targetBasePart = imported.get(resolveTarget(deepSlide, rel.target))
      return `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${relativeTarget(baseSlide, targetBasePart)}"/>`
    })
    .join('') +
  '</Relationships>\n'

// ---------------------------------------------------------------------------
// 4. Extend [Content_Types].xml for every imported part.
// ---------------------------------------------------------------------------
const contentTypes = await readPart(base, '[Content_Types].xml')
const additions = []
for (const basePart of imported.values()) {
  if (/\.rels$/.test(basePart)) continue
  const contentType = contentTypeFor(basePart)
  if (contentType === undefined) continue
  if (contentTypes.includes(`PartName="/${basePart}"`)) continue
  additions.push(`<Override PartName="/${basePart}" ContentType="${contentType}"/>`)
}
const patchedContentTypes = additions.length === 0
  ? contentTypes
  : contentTypes.replace('</Types>', `${additions.join('')}</Types>`)

// ---------------------------------------------------------------------------
// 5. Write the merged package.
// ---------------------------------------------------------------------------
const out = new JSZip()
for (const name of baseNames) {
  if (name === baseSlide || name === relsPart(baseSlide) || name === '[Content_Types].xml') continue
  out.file(name, await readBytes(base, name))
}
for (const [deepPart, basePart] of imported) {
  out.file(basePart, await readBytes(deep, deepPart))
}
for (const [name, xml] of rewrittenRels) out.file(name, xml)
out.file(baseSlide, await readPart(deep, deepSlide))
out.file(relsPart(baseSlide), slideRelsXml)
out.file('[Content_Types].xml', patchedContentTypes)

const buffer = await out.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
writeFileSync(resolve(outPath), buffer)

console.log(JSON.stringify({
  out: resolve(outPath),
  bytes: buffer.length,
  replacedSlide: baseSlide,
  sourceSlide: deepSlide,
  imported: Object.fromEntries(imported),
  droppedClosure: ['slideLayout', 'slideMaster', 'theme'],
  contentTypesAdded: additions.length,
}, null, 2))
