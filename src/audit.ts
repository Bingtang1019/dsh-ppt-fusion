import { allowedPalette, type TokensFile } from './schema/tokens.ts'

/**
 * One finding in the unified report.
 *
 * The shape is fixed by plan §3.8 so that `validate`, `audit`, the OPC checks and
 * the engine gates can all contribute to one list without a translation layer.
 */
export interface FusionFinding {
  readonly level: 'error' | 'warning'
  /** Which gate produced the finding: `manifest`, `ir`, `deep`, `theme`, `palette`, `pptx`. */
  readonly source: string
  /** 1-based page number when the finding is about a page. */
  readonly page?: number
  /** Stable rule id, used by tests instead of the message text. */
  readonly rule: string
  readonly message: string
}

/** Aggregate report returned by `validate --json` and `audit --json`. */
export interface FusionReport {
  readonly ok: boolean
  readonly findings: readonly FusionFinding[]
  /** Gates that actually ran, in order. */
  readonly sources: readonly string[]
}

/**
 * The unified audit gate report (plan §3.8): `validate`'s findings plus the package,
 * engine, compat and pixel sources, and the reasons a source could not run.
 */
export interface FusionAuditReport extends FusionReport {
  /** Report schema version; bumped only for a breaking shape change. */
  readonly schemaVersion: 1
  /** `--strict` makes warnings fail as well as errors. */
  readonly strict: boolean
  /** Workspace-relative path of the audited package, or null when none exists. */
  readonly artifact: string | null
  /** Compat level the package was linted at, or null when nothing was linted. */
  readonly compatLevel: string | null
  /** Whether the opt-in pixel (ΔE) check ran. */
  readonly pixels: boolean
  /** Sources that could not run, each with the reason. */
  readonly skipped: readonly string[]
}

/** Hex literals that are legitimate in any palette: pure white and pure black. */
const NEUTRALS = ['#FFFFFF', '#000000']

/**
 * Paint literals in either presentation form: `fill="#RRGGBB"` as an attribute,
 * or `fill: #RRGGBB` inside a `style` attribute.
 */
const PAINT_ATTRIBUTES = /\b(?:fill|stroke|stop-color|flood-color)\s*[:=]\s*"?(#[0-9a-fA-F]{3,8})/g

/**
 * Collect every hex literal a deep page paints with.
 *
 * @param svg - page SVG source.
 * @returns uppercase literals in document order, duplicates preserved.
 */
export function paintedColors(svg: string): string[] {
  const found: string[] = []
  for (const match of svg.matchAll(PAINT_ATTRIBUTES)) {
    const value = match[1]
    if (value === undefined) continue
    found.push(expandShorthand(value).toUpperCase())
  }
  return found
}

/** Expand `#abc` to `#AABBCC`; leave longer forms alone. */
function expandShorthand(value: string): string {
  const upper = value.toUpperCase()
  if (upper.length !== 4) return upper
  return `#${upper[1]}${upper[1]}${upper[2]}${upper[2]}${upper[3]}${upper[3]}`
}

/**
 * Minimal palette audit (plan §3.2 item 3, M2 scope): every colour a deep page
 * paints must exist in the deck's token palette.
 *
 * M8 adds the ΔE comparison against sampled pixels; this pass only answers "is
 * this literal even in the palette", which already catches a page that hardcodes
 * a colour instead of reading `tokens.json`.
 *
 * @param tokens - the deck's exported tokens.
 * @param pages - deep pages to inspect, each with its 1-based index.
 * @returns one finding per page that paints an unknown colour.
 */
export function collectPaletteFindings(
  tokens: TokensFile,
  pages: readonly { page?: number; path: string; svg: string }[],
): FusionFinding[] {
  const allowed = new Set([...allowedPalette(tokens), ...NEUTRALS])
  const findings: FusionFinding[] = []
  for (const entry of pages) {
    const unknown = [...new Set(paintedColors(entry.svg).filter((color) => !allowed.has(color)))]
    if (unknown.length === 0) continue
    findings.push({
      level: 'warning',
      source: 'palette',
      ...(entry.page === undefined ? {} : { page: entry.page }),
      rule: 'palette-unknown-color',
      message: `${entry.path} paints ${unknown.join(', ')} which is not in the deck palette (${allowed.size} literals from theme "${tokens.themeId}")`,
    })
  }
  return findings
}

/**
 * Build a report from a finding list.
 *
 * @param findings - all findings collected so far.
 * @param sources - gates that ran.
 * @returns the aggregate report; `ok` is false when any error-level finding exists.
 */
export function buildReport(findings: readonly FusionFinding[], sources: readonly string[]): FusionReport {
  return { ok: findings.every((finding) => finding.level !== 'error'), findings, sources }
}

/**
 * @param findings - findings to render.
 * @returns one line per finding, errors first, in the order given.
 */
export function formatFindings(findings: readonly FusionFinding[]): string {
  return findings
    .map((finding) => {
      const where = finding.page === undefined ? '' : ` page ${String(finding.page)}`
      return `[${finding.level.toUpperCase()}] ${finding.source}${where}: ${finding.rule}: ${finding.message}`
    })
    .join('\n')
}
