import JSZip from 'jszip'
import { DshPptFailure } from '../engine/errors.ts'

/** One relationship inside a `.rels` part. */
export interface Relationship {
  readonly id: string
  readonly type: string
  readonly target: string
  readonly targetMode?: 'External'
}

/** What `auditPackage` can report. */
export interface OpcFinding {
  readonly level: 'error' | 'warning'
  readonly rule: string
  readonly message: string
}

/** Relationship types this package reasons about. */
export const REL = {
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  chart: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  package: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package',
} as const

/** Content types for the parts this package creates or moves. */
export const CONTENT_TYPE = {
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  notesSlide: 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
} as const

/**
 * OPC package model: parts by name, `[Content_Types].xml` defaults and overrides,
 * and lazily parsed relationship parts.
 *
 * Everything in the merge bridge works through this model so that the ZIP layer
 * (jszip) and the OPC layer (parts, relationships, content types) stay separate.
 */
export class OpcPackage {
  private readonly parts = new Map<string, Buffer>()
  private readonly rels = new Map<string, Relationship[]>()
  private readonly defaults = new Map<string, string>()
  private readonly overrides = new Map<string, string>()

  /** @returns part names in a stable order. */
  names(): string[] {
    return [...this.parts.keys()].sort()
  }

  /** @returns true when the part exists. */
  has(name: string): boolean {
    return this.parts.has(name)
  }

  /** @returns the part's bytes. */
  part(name: string): Buffer {
    const bytes = this.parts.get(name)
    if (bytes === undefined) {
      throw new DshPptFailure('OutputMissing', `package part is absent: ${name}`, { detail: { part: name } })
    }
    return bytes
  }

  /** @returns the part as UTF-8 text. */
  text(name: string): string {
    return this.part(name).toString('utf8')
  }

  /** Adds or replaces a part. */
  setPart(name: string, bytes: Buffer | string): void {
    this.parts.set(name, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
  }

  /** Removes a part and any relationship part that belonged to it. */
  removePart(name: string): void {
    this.parts.delete(name)
    this.rels.delete(relsPartName(name))
  }

  /**
   * @param part - part name.
   * @returns its relationship part's name, whether or not it exists.
   */
  relationshipPartOf(part: string): string {
    return relsPartName(part)
  }

  /**
   * Read a part's relationships, parsing the `.rels` part on first use.
   *
   * @param part - part name whose relationships to read.
   * @returns the relationships in document order.
   */
  relationshipsOf(part: string): Relationship[] {
    const relsName = relsPartName(part)
    const cached = this.rels.get(relsName)
    if (cached !== undefined) return cached
    const text = this.parts.get(relsName)?.toString('utf8')
    const parsed = text === undefined ? [] : parseRels(text)
    this.rels.set(relsName, parsed)
    return parsed
  }

  /**
   * Replace a part's relationships.
   *
   * @param part - part name.
   * @param relationships - the complete new list.
   */
  setRelationships(part: string, relationships: readonly Relationship[]): void {
    const relsName = relsPartName(part)
    this.rels.set(relsName, [...relationships])
    this.parts.set(relsName, Buffer.from(serializeRels(relationships), 'utf8'))
  }

  /** @returns true when the part carries a relationship part. */
  hasRelationships(part: string): boolean {
    return this.parts.has(relsPartName(part))
  }

  /** @returns the extension defaults declared in `[Content_Types].xml`. */
  contentDefaults(): Map<string, string> {
    return new Map(this.defaults)
  }

  /** @returns the part-name overrides declared in `[Content_Types].xml`. */
  contentOverrides(): Map<string, string> {
    return new Map(this.overrides)
  }

  /**
   * Ensure a part has a content type: an override for the exact part, or a
   * default for its extension when one is already declared.
   *
   * @param name - part name.
   * @param contentType - type to declare when the part has none.
   * @returns true when `[Content_Types].xml` needs rewriting.
   */
  ensureContentType(name: string, contentType: string | undefined): boolean {
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    if (this.overrides.has(name)) return false
    if (this.defaults.has(extension)) return false
    if (contentType === undefined) return false
    this.overrides.set(name, contentType)
    return true
  }

  /**
   * Declare an extension default in `[Content_Types].xml`.
   *
   * Real packages declare `rels` and `xml` here; a package built from scratch in a
   * test has to say so explicitly, which is why this is a separate call from
   * `ensureContentType`.
   *
   * @param extension - file extension without the dot.
   * @param contentType - the type every part with that extension gets.
   */
  declareDefault(extension: string, contentType: string): void {
    this.defaults.set(extension.toLowerCase(), contentType)
  }

  /**
   * @param name - part name.
   * @returns the content type that applies, or undefined when none does.
   */
  contentTypeOf(name: string): string | undefined {
    const override = this.overrides.get(name)
    if (override !== undefined) return override
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    return this.defaults.get(extension)
  }

  /** Serialize `[Content_Types].xml` from the current defaults and overrides. */
  private writeContentTypes(): void {
    const defaults = [...this.defaults.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`)
    const overrides = [...this.overrides.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`)
    this.parts.set(
      '[Content_Types].xml',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}${overrides.join('')}</Types>\n`,
        'utf8',
      ),
    )
  }

  /**
   * Read a package from pptx bytes.
   *
   * @param bytes - the file contents.
   * @param options.zip - jszip loader, injected for tests.
   * @returns the parsed package.
   * @throws DshPptFailure `ContractViolation` when `[Content_Types].xml` is absent.
   */
  static async read(bytes: Buffer, options: { zip?: typeof JSZip } = {}): Promise<OpcPackage> {
    const zip = await (options.zip ?? JSZip).loadAsync(bytes)
    const pkg = new OpcPackage()
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      pkg.parts.set(name, await entry.async('nodebuffer'))
    }
    const contentTypes = pkg.parts.get('[Content_Types].xml')?.toString('utf8')
    if (contentTypes === undefined) {
      throw new DshPptFailure('ContractViolation', 'the package has no [Content_Types].xml')
    }
    for (const match of contentTypes.matchAll(/<Default\s+Extension="([^"]+)"\s+ContentType="([^"]+)"/g)) {
      pkg.defaults.set((match[1] ?? '').toLowerCase(), match[2] ?? '')
    }
    for (const match of contentTypes.matchAll(/<Override\s+PartName="([^"]+)"\s+ContentType="([^"]+)"/g)) {
      pkg.overrides.set((match[1] ?? '').replace(/^\//, ''), match[2] ?? '')
    }
    return pkg
  }

  /**
   * Write the package back to pptx bytes.
   *
   * Part order and per-entry timestamps are fixed so that the output is stable
   * for identical input (tier T2 in plan §7.2): names sorted, and every entry
   * stamped with the same DOS epoch.
   *
   * @param options.zip - jszip loader, injected for tests.
   * @param options.date - timestamp used for every entry.
   * @returns the serialized package.
   */
  async write(options: { zip?: typeof JSZip; date?: Date } = {}): Promise<Buffer> {
    this.writeContentTypes()
    const zip = new (options.zip ?? JSZip)()
    const date = options.date ?? new Date(Date.UTC(1980, 0, 1, 0, 0, 0))
    for (const name of this.names()) {
      zip.file(name, this.parts.get(name) ?? Buffer.alloc(0), { date, binary: true })
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' })
  }

  /** Deep copy, so a merge can be attempted without mutating its inputs. */
  clone(): OpcPackage {
    const copy = new OpcPackage()
    for (const [name, bytes] of this.parts) copy.parts.set(name, Buffer.from(bytes))
    for (const [name, rels] of this.rels) copy.rels.set(name, rels.map((rel) => ({ ...rel })))
    for (const [extension, type] of this.defaults) copy.defaults.set(extension, type)
    for (const [name, type] of this.overrides) copy.overrides.set(name, type)
    return copy
  }
}

/**
 * @param relsName - a `.rels` part name.
 * @returns the part that owns it; the empty string for the package root.
 */
export function ownerOfRelsPart(relsName: string): string {
  if (relsName === '_rels/.rels') return ''
  return relsName.replace(/_rels\/([^/]+)\.rels$/, '$1')
}

/** @param part - part name. @returns the name of its `.rels` part. */
export function relsPartName(part: string): string {
  const cut = part.lastIndexOf('/')
  return `${part.slice(0, cut)}/_rels/${part.slice(cut + 1)}.rels`
}

/** @param part - part name. @returns its directory, without a trailing slash. */
export function partDir(part: string): string {
  return part.slice(0, part.lastIndexOf('/'))
}

/** @param part - part name. @returns the last path segment. */
export function partBase(part: string): string {
  return part.slice(part.lastIndexOf('/') + 1)
}

/**
 * Parse a `.rels` document.
 *
 * @param xml - the relationship part's text.
 * @returns relationships in document order.
 */
export function parseRels(xml: string): Relationship[] {
  return [...xml.matchAll(/<Relationship\b[^>]*\/?>/g)].map((match) => {
    const attribute = (name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(match[0])?.[1]
    const mode = attribute('TargetMode')
    return {
      id: attribute('Id') ?? '',
      type: attribute('Type') ?? '',
      target: attribute('Target') ?? '',
      ...(mode === 'External' ? { targetMode: 'External' as const } : {}),
    }
  })
}

/**
 * Serialize relationships back into a `.rels` document.
 *
 * @param relationships - relationships to write.
 * @returns the document text.
 */
export function serializeRels(relationships: readonly Relationship[]): string {
  const rows = relationships.map(
    (rel) =>
      `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"${rel.targetMode === 'External' ? ' TargetMode="External"' : ''}/>`,
  )
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows.join('')}</Relationships>\n`
}

/**
 * Resolve a relationship target against the part that declares it.
 *
 * Handles package-absolute targets (`/ppt/slides/slide1.xml`), `..` segments and
 * redundant `.` segments; external targets are the caller's business.
 *
 * @param fromPart - part declaring the relationship.
 * @param target - the raw target string.
 * @returns the resolved part name.
 */
export function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '')
  // The package root owns `_rels/.rels` and has no directory of its own.
  if (fromPart === '') return target.replace(/^\.\//, '')
  const segments = partDir(fromPart).split('/')
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

/**
 * Build a target string that points from one part at another.
 *
 * @param fromPart - part declaring the relationship.
 * @param toPart - target part.
 * @returns a relative target.
 */
export function relativeTarget(fromPart: string, toPart: string): string {
  const from = partDir(fromPart).split('/')
  const to = toPart.split('/')
  while (from.length > 0 && to.length > 0 && from[0] === to[0]) {
    from.shift()
    to.shift()
  }
  return [...from.map(() => '..'), ...to].join('/')
}

/**
 * List the slide parts in presentation order.
 *
 * Order comes from `p:sldIdLst`, not from file names: the merge depends on it.
 *
 * @param pkg - the package.
 * @returns slide part names, in presentation order.
 */
export function listSlides(pkg: OpcPackage): string[] {
  const presentation = pkg.text('ppt/presentation.xml')
  const rels = new Map(pkg.relationshipsOf('ppt/presentation.xml').map((rel) => [rel.id, resolveTarget('ppt/presentation.xml', rel.target)]))
  const ordered: string[] = []
  for (const match of presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const target = rels.get(match[1] ?? '')
    if (target !== undefined && pkg.has(target)) ordered.push(target)
  }
  return ordered
}

/**
 * Audit a package's OPC structure and the single-master product invariant.
 *
 * @param pkg - the package.
 * @param options.requireSingleMaster - fail when the package declares more than
 *   one slide master (plan §3.5 P1).
 * @returns one finding per problem; an empty list means the package passed.
 */
export function auditPackage(pkg: OpcPackage, options: { requireSingleMaster?: boolean } = {}): OpcFinding[] {
  const findings: OpcFinding[] = []
  const names = pkg.names()

  for (const name of names) {
    if (!name.endsWith('.rels')) continue
    const ids = new Set<string>()
    for (const rel of parseRels(pkg.text(name))) {
      if (ids.has(rel.id)) findings.push({ level: 'error', rule: 'duplicate-rid', message: `${name} declares ${rel.id} twice` })
      ids.add(rel.id)
      if (rel.targetMode === 'External') continue
      // `_rels/.rels` belongs to the package root, so its targets resolve from the
      // archive root rather than from a `_rels` directory.
      const owner = ownerOfRelsPart(name)
      const target = resolveTarget(owner, rel.target)
      if (!pkg.has(target)) {
        findings.push({ level: 'error', rule: 'dangling-relationship', message: `${name}#${rel.id} points at the missing part ${target}` })
      }
    }
  }

  for (const name of names) {
    if (name === '[Content_Types].xml') continue
    if (pkg.contentTypeOf(name) === undefined) {
      findings.push({ level: 'error', rule: 'missing-content-type', message: `${name} has no content type` })
    }
  }

  const slides = names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
  const listed = listSlides(pkg)
  if (listed.length !== slides.length) {
    findings.push({
      level: 'error',
      rule: 'slide-count',
      message: `p:sldIdLst lists ${String(listed.length)} slides but the package holds ${String(slides.length)}`,
    })
  }

  const masters = names.filter((name) => /^ppt\/slideMasters\/slideMaster\d+\.xml$/.test(name))
  if (options.requireSingleMaster === true && masters.length !== 1) {
    findings.push({
      level: 'error',
      rule: 'multi-master',
      message: `P1 requires exactly one slideMaster; the package holds ${String(masters.length)} (${masters.join(', ')})`,
    })
  }

  const layoutOwners = new Set<string>()
  for (const name of names.filter((entry) => /^ppt\/slideLayouts\/_rels\/slideLayout\d+\.xml\.rels$/.test(entry))) {
    const layout = name.replace('_rels/', '').replace(/\.rels$/, '')
    const rel = parseRels(pkg.text(name)).find((entry) => entry.type.endsWith('/slideMaster'))
    if (rel !== undefined) layoutOwners.add(resolveTarget(layout, rel.target))
  }
  // Part of P1, so it is reported only when the caller requires the invariant:
  // the merge's escape hatch deliberately produces two masters.
  if (options.requireSingleMaster === true && layoutOwners.size > 1) {
    findings.push({
      level: 'error',
      rule: 'multi-master',
      message: `slide layouts reference ${String(layoutOwners.size)} different masters: ${[...layoutOwners].join(', ')}`,
    })
  }

  return findings
}

/**
 * Pick a free part name in `directory`, keeping the original prefix and numbering.
 *
 * @param pkg - the package to check against.
 * @param taken - names already claimed during this merge.
 * @param desired - the name the source package used.
 * @returns an unused name with the same directory, prefix and extension.
 */
export function freePartName(pkg: OpcPackage, taken: ReadonlySet<string>, desired: string): string {
  if (!pkg.has(desired) && !taken.has(desired)) return desired
  const directory = partDir(desired)
  const base = partBase(desired)
  const dot = base.lastIndexOf('.')
  const stem = dot < 0 ? base : base.slice(0, dot)
  const extension = dot < 0 ? '' : base.slice(dot)
  const prefix = stem.replace(/\d+$/, '')
  for (let index = 1; ; index += 1) {
    const candidate = `${directory}/${prefix}${String(index)}${extension}`
    if (!pkg.has(candidate) && !taken.has(candidate)) return candidate
  }
}
