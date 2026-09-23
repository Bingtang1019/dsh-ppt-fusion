import type { DesignProfile } from '../schema/design-profile.ts'
import { listSlides, type OpcPackage } from './opc.ts'

/**
 * Apply a design profile's font families to a rendered package (V7.2 B2).
 *
 * pptwise resolves a font stack against a hardcoded safe-font allowlist
 * (`resolveFontFace` in the pinned 0.35.0), so a deck-local theme that names MiSans
 * still renders with a listed fallback. This pass rewrites the run typefaces to the
 * profile's families after the merge: titles (large runs) take the heading family,
 * large numerals take the number family when one is declared, everything else takes
 * the body family. The EA slot follows the same choice, so CJK runs do not keep the
 * engine's default face.
 */

/** Run sizes at or above this (hundredths of a point) are treated as titles. */
export const FONT_TITLE_MIN_SZ = 2800

/** Large numerals at or above this take the profile's number family, when declared. */
export const FONT_NUMBER_MIN_SZ = 3200

/** What one font pass changed. */
export interface FontApplicationReport {
  readonly runs: number
  readonly latin: number
  readonly ea: number
  readonly numberRuns: number
}

/** One run as the slide XML spells it: the typefaces its size and text select. */
interface Faces {
  readonly primary: string
  readonly ea: string
  readonly isNumber: boolean
}

/** @returns the typefaces a run's size selects: `heading` or `body`, plus `number` for large digits. */
function facesFor(sizeSz: number | null, text: string, profile: DesignProfile): Faces {
  const isNumber = sizeSz !== null && sizeSz >= FONT_NUMBER_MIN_SZ && /^[\d\s.,%+/-]+$/u.test(text)
  if (isNumber) return { primary: profile.fonts.number, ea: profile.fonts.number, isNumber: true }
  if (sizeSz !== null && sizeSz >= FONT_TITLE_MIN_SZ) return { primary: profile.fonts.heading, ea: profile.fonts.heading, isNumber: false }
  return { primary: profile.fonts.body, ea: profile.fonts.body, isNumber: false }
}

/** Matches one run-property fragment: a self-closing element or a paired one with children. */
const PROPERTY_RE = /<a:(?:rPr|defRPr|endParaRPr)\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/a:(?:rPr|defRPr|endParaRPr)>)/g

/** @returns every `<a:t>` text inside one XML fragment, concatenated. */
function textOf(fragment: string): string {
  return [...fragment.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => match[1] ?? '').join('')
}

/** @returns `fragment` with the profile's families in its latin/ea/cs slots. */
function rewriteFaces(fragment: string, faces: Faces): string {
  return fragment
    .replace(/(<a:latin typeface=")[^"]*(")/g, `$1${faces.primary}$2`)
    .replace(/(<a:ea typeface=")[^"]*(")/g, `$1${faces.ea}$2`)
    .replace(/(<a:cs typeface=")[^"]*(")/g, `$1${faces.primary}$2`)
}

/**
 * Rewrite every run's typefaces to the profile's families.
 *
 * Paragraphs are walked as a unit: their text drives the numeral check, each property
 * fragment's own `sz` drives the title/body choice, and both `a:rPr` and the
 * `a:defRPr`/`a:endParaRPr` defaults are rewritten so a run without explicit
 * properties does not inherit the engine's face.
 *
 * @param pkg - merged package, mutated in place.
 * @param profile - validated design profile carrying the declared families.
 * @returns how many property fragments and typeface slots were rewritten.
 */
export function applyProfileFonts(pkg: OpcPackage, profile: DesignProfile): FontApplicationReport {
  let runs = 0
  let latin = 0
  let ea = 0
  let numberRuns = 0
  for (const slidePart of listSlides(pkg)) {
    let xml = pkg.text(slidePart)
    xml = xml.replace(/<a:p\b[\s\S]*?<\/a:p>/g, (paragraph) => {
      const paragraphText = textOf(paragraph)
      return paragraph.replace(PROPERTY_RE, (fragment) => {
        const sizeText = /sz="(\d+)"/.exec(fragment)?.[1]
        const faces = facesFor(sizeText === undefined ? null : Number(sizeText), paragraphText, profile)
        runs += 1
        latin += (fragment.match(/<a:latin /g) ?? []).length
        ea += (fragment.match(/<a:ea /g) ?? []).length
        if (faces.isNumber) numberRuns += 1
        return rewriteFaces(fragment, faces)
      })
    })
    pkg.setPart(slidePart, xml)
  }
  return { runs, latin, ea, numberRuns }
}

/**
 * @param pkg - package to inspect.
 * @returns the distinct typefaces the slides declare, for gates and reports.
 */
export function slideTypefaces(pkg: OpcPackage): string[] {
  const faces = new Set<string>()
  for (const slidePart of listSlides(pkg)) {
    for (const match of pkg.text(slidePart).matchAll(/<a:(?:latin|ea|cs) typeface="([^"]+)"/g)) {
      if (match[1] !== undefined) faces.add(match[1])
    }
  }
  return [...faces].sort()
}
