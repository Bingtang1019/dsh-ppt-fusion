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
      // XML 1.0 end-of-line handling: a parser folds CRLF and CR to LF, so the
      // engines' platform line endings must not read as a content difference.
      .replace(/\r\n?/g, '\n')
      // Producer metadata: created/modified stamps, revision counter, edit time.
      .replace(/<dcterms:created[^>]*>[^<]*<\/dcterms:created>/g, '<dcterms:created/>')
      .replace(/<dcterms:modified[^>]*>[^<]*<\/dcterms:modified>/g, '<dcterms:modified/>')
      .replace(/<cp:revision>[^<]*<\/cp:revision>/g, '<cp:revision/>')
      .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/g, '<cp:lastModifiedBy/>')
      .replace(/<TotalTime>[^<]*<\/TotalTime>/g, '<TotalTime/>')
      .replace(/<Application>[^<]*<\/Application>/g, '<Application/>')
      .replace(/<AppVersion>[^<]*<\/AppVersion>/g, '<AppVersion/>')
      // Narration advance timing: the exporter measures the committed audio with the
      // host's ffprobe, whose version changes the last digits. The gate compares the
      // attribute's presence and the audio bytes, not the measured number.
      .replace(/advTm="[^"]*"/g, 'advTm=""')
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
 * Explain the first divergence of one part, for a failure log.
 *
 * The comparison reports part names only; a red leg on another host needs the
 * surrounding text to tell a real regression from an environment difference.
 *
 * @param fresh - canonical package produced by this run.
 * @param recorded - canonical package recorded in the golden.
 * @param name - part name to explain.
 * @returns a bounded excerpt of both sides at the first difference.
 */
export function describePartDifference(fresh: CanonicalPackage, recorded: CanonicalPackage, name: string): string {
  const left = fresh.parts.get(name)
  const right = recorded.parts.get(name)
  if (left === undefined) return `${name}: only in the recorded package`
  if (right === undefined) return `${name}: only in the fresh package`
  if (typeof left === 'string' && typeof right === 'string') return `${name}: ${firstTextDifference(left, right)}`
  if (isHashed(left) && isHashed(right)) return `${name}: bytes ${left.sha256.slice(0, 16)}… vs ${right.sha256.slice(0, 16)}…`
  if (isNested(left) && isNested(right)) {
    const nested = compareCanonical(left.nested, right.nested)
    const first = nested.differences[0]
    if (first === undefined) return `${name}: nested packages are equal`
    return `${name} → ${describePartDifference(left.nested, right.nested, first.slice(first.indexOf(': ') + 2))}`
  }
  return `${name}: the two sides hold different kinds of part`
}

/** Characters of context shown on each side of the first divergence. */
const DIFF_CONTEXT = 90

/**
 * @param part - canonical part to inspect.
 * @returns whether the part holds a hash of binary bytes.
 */
function isHashed(part: CanonicalPart): part is { readonly sha256: string } {
  return typeof part === 'object' && 'sha256' in part
}

/**
 * @param part - canonical part to inspect.
 * @returns whether the part wraps a nested package.
 */
function isNested(part: CanonicalPart): part is { readonly nested: CanonicalPackage } {
  return typeof part === 'object' && 'nested' in part
}

/**
 * @param left - fresh text.
 * @param right - recorded text.
 * @returns the first differing offset with a bounded excerpt of both sides.
 */
function firstTextDifference(left: string, right: string): string {
  const shortest = Math.min(left.length, right.length)
  let offset = 0
  while (offset < shortest && left[offset] === right[offset]) offset += 1
  const start = Math.max(0, offset - DIFF_CONTEXT)
  const fresh = left.slice(start, offset + DIFF_CONTEXT)
  const recorded = right.slice(start, offset + DIFF_CONTEXT)
  return `first difference at offset ${String(offset)} (fresh ${String(left.length)} chars, recorded ${String(right.length)} chars)\n    fresh:    …${fresh}…\n    recorded: …${recorded}…`
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
