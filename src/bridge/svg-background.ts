import type { DesignProfile, DesignRole } from '../schema/design-profile.ts'

/**
 * Deterministic programmatic backgrounds (V7.2 B2.5, `background.mode: "svg"`).
 *
 * The generator paints only blends of the profile's own colours, so a background
 * can never introduce an off-palette ink, and every call with the same role and
 * profile returns byte-identical SVG (T1). Roles compose differently — a cover
 * band, table-of-contents rules, a section watermark ring, content columns, an
 * ending band — while staying quiet enough that the profile's text colours keep
 * their contrast once the overlay is applied.
 */

/** One generated background and the opaque colours it paints. */
export interface SvgBackground {
  readonly svg: string
  /** Every opaque colour literal in the SVG, deduplicated in first-use order. */
  readonly colours: readonly string[]
}

/** Design-space canvas the geometry constants are written for. */
const DESIGN_WIDTH = 1280
const DESIGN_HEIGHT = 720

/** @param hex - `#RRGGBB`. @returns the three channels. */
function channels(hex: string): readonly [number, number, number] {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)]
}

/** @param value - channel value. @returns the clamped, rounded channel. */
function byte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/**
 * @param base - `#RRGGBB` to start from.
 * @param other - `#RRGGBB` to blend in.
 * @param ratio - share of `other`, 0–1.
 * @returns the uppercase blended colour.
 */
export function mixHex(base: string, other: string, ratio: number): string {
  const from = channels(base)
  const to = channels(other)
  const mixed = from.map((value, index) => byte(value + ((to[index] ?? value) - value) * ratio))
  return `#${mixed.map((value) => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/** @param match - one geometry list entry. @returns the rounded scaled value. */
function scale(value: number, size: number): number {
  return Math.round(value * size)
}

/**
 * @param role - page role the background is composed for.
 * @param profile - validated design profile supplying the canvas and palette.
 * @returns the SVG source and the opaque colours it paints.
 */
export function svgBackground(role: DesignRole, profile: DesignProfile): SvgBackground {
  const width = Math.round(profile.canvas.widthEmu / 9525)
  const height = Math.round(profile.canvas.heightEmu / 9525)
  const px = (value: number): number => scale(value, width / DESIGN_WIDTH)
  const py = (value: number): number => scale(value, height / DESIGN_HEIGHT)
  const { bg, watermark, accent, muted } = profile.palette
  const wash = mixHex(bg, watermark, 0.55)
  const tint = mixHex(bg, accent, 0.12)
  const tintStrong = mixHex(bg, accent, 0.22)
  const line = mixHex(bg, muted, 0.18)
  const colours: string[] = []
  const use = (colour: string): string => {
    if (!colours.includes(colour)) colours.push(colour)
    return colour
  }
  for (const colour of [bg, wash, tint, tintStrong, line]) use(colour)

  const grid: string[] = []
  for (let x = 160; x < DESIGN_WIDTH; x += 160) grid.push(`M${String(px(x))} 0V${String(height)}`)
  for (let y = 120; y < DESIGN_HEIGHT; y += 120) grid.push(`M0 ${String(py(y))}H${String(width)}`)
  const common = [
    `<defs><linearGradient id="dsh-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${use(bg)}"/><stop offset="1" stop-color="${use(wash)}"/></linearGradient></defs>`,
    `<rect width="${String(width)}" height="${String(height)}" fill="url(#dsh-bg)"/>`,
    `<path d="${grid.join(' ')}" fill="none" stroke="${use(line)}" stroke-width="1"/>`,
  ]
  const shapes: string[] = []
  switch (role) {
    case 'cover':
      shapes.push(
        `<rect x="${String(px(880))}" y="0" width="${String(width - px(880))}" height="${String(height)}" fill="${use(tint)}"/>`,
        `<circle cx="${String(px(210))}" cy="${String(py(610))}" r="${String(px(150))}" fill="none" stroke="${use(tintStrong)}" stroke-width="${String(px(46))}"/>`,
        `<rect x="${String(px(96))}" y="${String(py(96))}" width="${String(px(84))}" height="${String(py(10))}" fill="${use(tintStrong)}"/>`,
      )
      break
    case 'toc':
      for (let index = 0; index < 4; index += 1) {
        shapes.push(
          `<rect x="${String(px(140))}" y="${String(py(180 + index * 110))}" width="${String(px(620 - index * 90))}" height="${String(py(18))}" rx="${String(py(9))}" fill="${use(index % 2 === 0 ? tintStrong : tint)}"/>`,
        )
      }
      break
    case 'section':
      shapes.push(
        `<rect x="0" y="${String(py(470))}" width="${String(width)}" height="${String(height - py(470))}" fill="${use(tint)}"/>`,
        `<circle cx="${String(px(1050))}" cy="${String(py(240))}" r="${String(px(210))}" fill="none" stroke="${use(tintStrong)}" stroke-width="${String(px(34))}"/>`,
        `<rect x="${String(px(120))}" y="${String(py(240))}" width="${String(px(360))}" height="${String(py(12))}" fill="${use(line)}"/>`,
      )
      break
    case 'content': {
      const gap = px(48)
      const margin = px(120)
      const cardWidth = Math.round((width - margin * 2 - gap * 2) / 3)
      for (let index = 0; index < 3; index += 1) {
        const x = margin + index * (cardWidth + gap)
        shapes.push(
          `<rect x="${String(x)}" y="${String(py(150))}" width="${String(cardWidth)}" height="${String(py(440))}" rx="${String(px(24))}" fill="${use(wash)}"/>`,
          `<rect x="${String(x)}" y="${String(py(150))}" width="${String(cardWidth)}" height="${String(py(8))}" rx="${String(py(4))}" fill="${use(tintStrong)}"/>`,
        )
      }
      break
    }
    case 'ending':
      shapes.push(
        `<rect x="${String(px(240))}" y="${String(py(300))}" width="${String(px(800))}" height="${String(py(120))}" rx="${String(px(24))}" fill="${use(tint)}"/>`,
        `<circle cx="${String(px(1040))}" cy="${String(py(570))}" r="${String(px(120))}" fill="none" stroke="${use(tintStrong)}" stroke-width="${String(px(28))}"/>`,
      )
      break
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}">${[...common, ...shapes].join('')}</svg>`
  return { svg, colours }
}
