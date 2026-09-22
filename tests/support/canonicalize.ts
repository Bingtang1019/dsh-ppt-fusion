import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'

/**
 * Semantic (tier T1) comparison of two `.pptx` packages, per plan §7.2.
 *
 * T1 compares the part list, the relationship graph, XML with volatile metadata
 * normalised, and binary parts by SHA-256. Byte equality is T2/T3 and is not what
 * this checks: the engines stamp their own times, so a byte comparison would be
 * red for reasons that carry no meaning.
 *
 * Two measured facts shape the implementation:
 * - `docProps/core.xml` timestamps and `cp:revision` differ between two exports of
 *   the same input (ADR-014);
 * - the embedded workbook under `ppt/embeddings/` carries its own OOXML with its
 *   own timestamps, so the comparison **recurses into embedded packages**
 *   (ADR-017). Without that recursion any deck with a native chart is permanently
 *   "different" for no reason.
 */

/** One canonical part: normalised XML text, a content hash, or a nested package. */
export type CanonicalPart = string | { readonly sha256: string } | { readonly nested: CanonicalPackage }

/** A package reduced to comparable form. */
export interface CanonicalPackage {
  readonly parts: ReadonlyMap<string, CanonicalPart>
}

/** Result of a comparison. */
export interface CanonicalComparison {
  readonly equal: boolean
  readonly differences: readonly string[]
  readonly parts: number
}

/** Extensions treated as nested OOXML packages. */
const NESTED_EXTENSIONS = ['.xlsx', '.docx', '.pptx', '.xlsm', '.docm']

/** XML parts whose volatile fields are normalised before comparison. */
function normalizeXml(xml: string): string {
  return (
    xml
      // Producer metadata: created/modified stamps, revision counter, edit time.
      .replace(/<dcterms:created[^>]*>[^<]*<\/dcterms:created>/g, '<dcterms:created/>')
      .replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/g, '<dcterms:modified/>')
      .replace(/<cp:revision>[^<]*<\/cp:revision>/g, '<cp:revision/>')
      .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/g, '<cp:lastModifiedBy/>')
      .replace(/<TotalTime>[^<]*<\/TotalTime>/g, '<TotalTime/>')
      .replace(/<Application>[^<]*<\/Application>/g, '<Application/>')
      .replace(/<AppVersion>[^<]*<\/AppVersion>/g, '<AppVersion/>')
      // Whitespace between tags is formatting, not content.
      .replace(/>\s+</g, '><')
      .trim()
  )
}

/**
 * Reduce a package to its comparable form.
 *
 * @param bytes - the pptx file contents.
 * @param options.depth - recursion depth for embedded OOXML; the default stops one
 *   level in, which is where the measured differences live.
 * @returns the canonical package.
 */
export async function canonicalize(bytes: Buffer, options: { depth?: number } = {}): Promise<CanonicalPackage> {
  const depth = options.depth ?? 1
  const zip = await JSZip.loadAsync(bytes)
  const parts = new Map<string, CanonicalPart>()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    const buffer = await entry.async('nodebuffer')
    const lower = name.toLowerCase()
    if (/\.(xml|rels)$/.test(lower)) {
      parts.set(name, normalizeXml(buffer.toString('utf8')))
      continue
    }
    if (depth > 0 && NESTED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
      parts.set(name, { nested: await canonicalize(buffer, { depth: depth - 1 }) })
      continue
    }
    parts.set(name, { sha256: createHash('sha256').update(buffer).digest('hex') })
  }
  return { parts }
}

/** @returns the comparison key for one canonical part (a nested package serialises). */
function partKey(part: CanonicalPart): string {
  if (typeof part === 'string') return part
  if ('sha256' in part) return part.sha256
  return `nested:${[...part.nested.parts.entries()]
    .map(([name, nested]) => `${name}=${partKey(nested)}`)
    .sort()
    .join(';')}`
}

/**
 * Compare two canonical packages.
 *
 * @param left - first package.
 * @param right - second package.
 * @returns equality, the differing part names, and the part count.
 */
export function compareCanonical(left: CanonicalPackage, right: CanonicalPackage): CanonicalComparison {
  const differences: string[] = []
  for (const name of new Set([...left.parts.keys(), ...right.parts.keys()])) {
    const a = left.parts.get(name)
    const b = right.parts.get(name)
    if (a === undefined) differences.push(`only in B: ${name}`)
    else if (b === undefined) differences.push(`only in A: ${name}`)
    else if (partKey(a) !== partKey(b)) differences.push(`differs: ${name}`)
  }
  return { equal: differences.length === 0, differences, parts: left.parts.size }
}

/**
 * Compare two pptx files semantically.
 *
 * @param leftPath - path of the first deck.
 * @param rightPath - path of the second deck.
 * @returns the comparison result.
 */
export async function canonicalFilesEqual(leftPath: string, rightPath: string): Promise<CanonicalComparison> {
  const left = await canonicalize(readFileSync(leftPath))
  const right = await canonicalize(readFileSync(rightPath))
  return compareCanonical(left, right)
}

/**
 * @param comparison - a comparison result.
 * @returns a printable summary, one differing part per line.
 */
export function describeComparison(comparison: CanonicalComparison): string {
  if (comparison.equal) return `semantically equal (${String(comparison.parts)} parts)`
  return [`semantically different (${String(comparison.parts)} parts):`, ...comparison.differences.map((entry) => `  ${entry}`)].join('\n')
}
