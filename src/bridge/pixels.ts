import { allowedPalette, type TokensFile } from '../schema/tokens.ts'
import type { FusionFinding } from '../audit.ts'

/**
 * Source-side colour difference check (plan §3.8 row 6): rasterise each deep page
 * with `sharp`, count the colours that survive a coverage filter, and compare them
 * with the deck palette in CIELAB.
 *
 * This is the `--pixels` opt-in, and it is deliberately a warning-only heuristic:
 * anti-aliasing and gradients invent colours that no palette contains, so the coverage
 * filter (ignore anything below 1 % of the opaque pixels) is what keeps the signal
 * usable. M8 owns the renderer-based ΔE matrix over the merged package; this check
 * covers the authored deep SVGs.
 */

/** One sampled colour and the share of opaque pixels it covers. */
export interface ColourSample {
  readonly hex: string
  readonly coverage: number
}

/** A sampled colour is only considered when it covers at least this share. */
export const PIXEL_COVERAGE_MIN = 0.01

/** Nearest-palette-colour difference above which a sample is reported. */
export const PIXEL_DELTA_E_LIMIT = 10

/** @param value - 0–255 channel. @returns two lowercase hex digits. */
function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

/** @param hex - `#RRGGBB`. @returns the channels in 0–255. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  const expanded = value.length === 3 ? value.split('').map((digit) => digit + digit).join('') : value
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  }
}

/** @param channel - 0–255. @returns the linear-light value. */
function linearise(channel: number): number {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** @param hex - `#RRGGBB`. @returns CIE L*a*b* under D65. */
function lab(hex: string): [number, number, number] {
  const { r, g, b } = hexToRgb(hex)
  const red = linearise(r)
  const green = linearise(g)
  const blue = linearise(b)
  const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) * 100
  const y = (red * 0.2126 + green * 0.7152 + blue * 0.0722) * 100
  const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) * 100
  const pivot = (value: number): number => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116)
  const fx = pivot(x / 95.047)
  const fy = pivot(y / 100)
  const fz = pivot(z / 108.883)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/**
 * @param left - first `#RRGGBB` colour.
 * @param right - second `#RRGGBB` colour.
 * @returns the CIE76 colour difference (0 = identical, 100 = black vs white).
 */
export function deltaE76(left: string, right: string): number {
  const [l1, a1, b1] = lab(left)
  const [l2, a2, b2] = lab(right)
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

/**
 * Rasterise an SVG and count the colours that survive the coverage filter.
 *
 * @param svg - the SVG bytes.
 * @param options.maxEdge - longest side of the sampling raster, in pixels.
 * @param options.minCoverage - share of opaque pixels a colour must reach.
 * @returns the surviving colours, most frequent first.
 */
export async function sampleSvgColours(svg: Buffer, options: { maxEdge?: number; minCoverage?: number } = {}): Promise<ColourSample[]> {
  const { default: sharp } = await import('sharp')
  const maxEdge = options.maxEdge ?? 256
  const minCoverage = options.minCoverage ?? PIXEL_COVERAGE_MIN
  const { data, info } = await sharp(svg)
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const counts = new Map<string, number>()
  let total = 0
  for (let offset = 0; offset + info.channels <= data.length; offset += info.channels) {
    if (info.channels === 4 && (data[offset + 3] ?? 0) < 250) continue
    const hex = `#${hexByte(data[offset] ?? 0)}${hexByte(data[offset + 1] ?? 0)}${hexByte(data[offset + 2] ?? 0)}`.toUpperCase()
    counts.set(hex, (counts.get(hex) ?? 0) + 1)
    total += 1
  }
  return [...counts.entries()]
    .map(([hex, count]) => ({ hex, coverage: total === 0 ? 0 : count / total }))
    .filter((sample) => sample.coverage >= minCoverage)
    .sort((left, right) => right.coverage - left.coverage)
}

/**
 * Compare each deep page's rasterised colours with the deck palette.
 *
 * @param tokens - the deck's exported tokens; its `allowedPalette` is the reference.
 * @param pages - deep pages with their 1-based index, relative path and SVG source.
 * @param options.limit - ΔE above which a colour is reported.
 * @returns one warning per page that paints an off-palette colour.
 */
export async function collectPixelFindings(
  tokens: TokensFile,
  pages: readonly { page?: number; path: string; svg: string }[],
  options: { limit?: number } = {},
): Promise<FusionFinding[]> {
  const limit = options.limit ?? PIXEL_DELTA_E_LIMIT
  const palette = [...allowedPalette(tokens)]
  const findings: FusionFinding[] = []
  if (palette.length === 0) return findings
  for (const entry of pages) {
    const samples = await sampleSvgColours(Buffer.from(entry.svg))
    const offenders = samples
      .map((sample) => ({ ...sample, delta: Math.min(...palette.map((colour) => deltaE76(sample.hex, colour))) }))
      .filter((sample) => sample.delta > limit)
      .sort((left, right) => right.delta - left.delta)
    if (offenders.length === 0) continue
    const top = offenders.slice(0, 3).map((sample) => `${sample.hex} (coverage ${(sample.coverage * 100).toFixed(1)} %, ΔE ${sample.delta.toFixed(1)})`)
    findings.push({
      level: 'warning',
      source: 'palette',
      ...(entry.page === undefined ? {} : { page: entry.page }),
      rule: 'palette-delta-e',
      message: `${entry.path} paints ${String(offenders.length)} sampled colour(s) more than ΔE ${String(limit)} from the palette: ${top.join(', ')}${offenders.length > 3 ? `, and ${String(offenders.length - 3)} more` : ''}`,
    })
  }
  return findings
}
