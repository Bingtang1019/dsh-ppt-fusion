import { DshPptFailure } from '../engine/errors.ts'
import type { DesignProfile } from '../schema/design-profile.ts'
import type { ThemeColors, ThemeFile } from '../schema/tokens.ts'

/**
 * Map a design profile onto a ThemeFile v2 (V7.2 B2).
 *
 * The profile describes the reference deck's measured system; the preset supplies
 * the page menu, shape language and motion story the theme file must keep. Colors
 * and fonts are replaced, and the result must pass the WCAG floor before it is
 * written: a failing palette is reported for a human decision, never silently
 * adjusted (plan §R25).
 */

/** Contrast floor for body-size text. */
export const PROFILE_CONTRAST_FLOOR = 4.5

/** Contrast floor for large text such as a title or a white-on-accent figure. */
export const PROFILE_LARGE_CONTRAST_FLOOR = 3

/** @returns the `#RRGGBB` channels of a hex literal. */
function channelsOf(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)]
}

/** @returns the relative luminance (0..1) of a `#RRGGBB` literal. */
export function relativeLuminance(hex: string): number {
  const [red, green, blue] = channelsOf(hex)
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

/**
 * @param foreground - `#RRGGBB` text colour.
 * @param background - `#RRGGBB` background colour.
 * @returns the WCAG contrast ratio (1..21).
 */
export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/** @returns `left` mixed with `right` at `weight` (0 keeps left, 1 returns right). */
export function mixHex(left: string, right: string, weight: number): string {
  const first = channelsOf(left)
  const second = channelsOf(right)
  const blend = first.map((channel, index) => Math.round(channel * (1 - weight) + (second[index] ?? 0) * weight))
  return `#${blend.map((channel) => channel.toString(16).padStart(2, '0').toUpperCase()).join('')}`
}

/**
 * Check the profile's text/background pairs against the WCAG floor.
 *
 * @param profile - validated design profile.
 * @throws DshPptFailure `ContractViolation` naming every failing pair, with the
 *   measured ratios, so the palette is adjusted by hand rather than silently.
 */
export function assertProfileContrast(profile: DesignProfile): void {
  const { palette } = profile
  const pairs: { name: string; foreground: string; background: string; floor: number }[] = [
    { name: 'body/bg', foreground: palette.body, background: palette.bg, floor: PROFILE_CONTRAST_FLOOR },
    { name: 'muted/bg', foreground: palette.muted, background: palette.bg, floor: PROFILE_CONTRAST_FLOOR },
    { name: 'title/bg', foreground: palette.title, background: palette.bg, floor: PROFILE_CONTRAST_FLOOR },
    { name: 'body/card', foreground: palette.body, background: palette.onAccent, floor: PROFILE_CONTRAST_FLOOR },
    { name: 'muted/card', foreground: palette.muted, background: palette.onAccent, floor: PROFILE_CONTRAST_FLOOR },
    { name: 'title/card', foreground: palette.title, background: palette.onAccent, floor: PROFILE_CONTRAST_FLOOR },
    { name: 'onAccent/accent', foreground: palette.onAccent, background: palette.accent, floor: PROFILE_LARGE_CONTRAST_FLOOR },
    // pptwise paints marked runs in `emphasisInk`, falling back to `accent`; the theme
    // leaves emphasisInk out, so accent must clear the large-text floor on the bg.
    { name: 'accent/bg', foreground: palette.accent, background: palette.bg, floor: PROFILE_LARGE_CONTRAST_FLOOR },
  ]
  const failures = pairs
    .map((pair) => ({ ...pair, ratio: contrastRatio(pair.foreground, pair.background) }))
    .filter((pair) => pair.ratio < pair.floor - 1e-9)
  if (failures.length > 0) {
    const detail = failures.map((pair) => `${pair.name} ${pair.ratio.toFixed(2)} < ${String(pair.floor)}`).join('; ')
    throw new DshPptFailure('ContractViolation', `the design profile palette fails the WCAG contrast floor: ${detail}; adjust the profile colours by hand`, {
      detail: { failures },
    })
  }
}

/** @returns a deterministic four-series palette derived from the accent colour. */
export function chartPaletteFrom(accent: string): string[] {
  const [hue, saturation, lightness] = hslOf(accent)
  const rotate = (degrees: number, satDelta: number, lightDelta: number): string =>
    hexOf(hue + degrees, clamp(saturation + satDelta, 0.25, 0.95), clamp(lightness + lightDelta, 0.16, 0.86))
  return [accent.toUpperCase(), rotate(26, 0, -0.12), rotate(-32, 0.06, 0.1), rotate(180, -0.2, 0), rotate(-72, -0.12, 0.18)]
}

/** @returns hue (degrees), saturation and lightness (0..1) of a hex literal. */
function hslOf(hex: string): [number, number, number] {
  const [red, green, blue] = channelsOf(hex).map((channel) => channel / 255) as [number, number, number]
  const maximum = Math.max(red, green, blue)
  const minimum = Math.min(red, green, blue)
  const lightness = (maximum + minimum) / 2
  if (maximum === minimum) return [0, 0, lightness]
  const delta = maximum - minimum
  const saturation = lightness > 0.5 ? delta / (2 - maximum - minimum) : delta / (maximum + minimum)
  const hue =
    maximum === red ? ((green - blue) / delta + (green < blue ? 6 : 0)) * 60 : maximum === green ? ((blue - red) / delta + 2) * 60 : ((red - green) / delta + 4) * 60
  return [hue, saturation, lightness]
}

/** @returns the `#RRGGBB` literal for an HSL triple (hue in degrees). */
function hexOf(hue: number, saturation: number, lightness: number): string {
  const normalized = ((hue % 360) + 360) % 360
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const section = normalized / 60
  const second = chroma * (1 - Math.abs((section % 2) - 1))
  const [red, green, blue] =
    section < 1
      ? [chroma, second, 0]
      : section < 2
        ? [second, chroma, 0]
        : section < 3
          ? [0, chroma, second]
          : section < 4
            ? [0, second, chroma]
            : section < 5
              ? [second, 0, chroma]
              : [chroma, 0, second]
  const offset = lightness - chroma / 2
  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0').toUpperCase())
    .join('')}`
}

/** @returns `value` clamped to the inclusive range. */
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** @param values - font stacks; @returns one stack with duplicates removed, order preserved. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))]
}

/**
 * Build the ThemeFile a design profile describes on top of a preset's menu.
 *
 * The returned theme **keeps the base theme's id**: pptwise resolves a deck-local
 * `theme.json` by id, so the IR's preset id must still name the file for the deck
 * to render with the profile's palette (measured: a deck-local theme with a
 * modified palette and the preset's id drives the rendered colours and fonts).
 *
 * @param base - the materialised preset theme (menu, shape and story are preserved).
 * @param profile - validated design profile.
 * @returns a new ThemeFile with the profile's colours, fonts and backgrounds.
 * @throws DshPptFailure `ContractViolation` when the palette fails the WCAG floor.
 */
export function themeFromProfile(base: ThemeFile, profile: DesignProfile): ThemeFile {
  assertProfileContrast(profile)
  const border = mixHex(profile.palette.muted, profile.palette.bg, 0.78)
  const colors: ThemeColors = {
    ...base.style.colors,
    bg: profile.palette.bg,
    surface: profile.palette.onAccent,
    panel: profile.palette.onAccent,
    primary: profile.palette.title,
    accent: profile.palette.accent,
    text: profile.palette.body,
    muted: profile.palette.muted,
    border,
    chartPalette: chartPaletteFrom(profile.palette.accent),
    cardStroke: border,
  }
  // The base theme's emphasis ink was tuned for the base background; the profile's
  // white-on-white combination fails pptwise's 3:1 marked-run gate, so the mapping
  // omits it and pptwise falls back to `accent` (ADR-066).
  delete colors.emphasisInk
  const background = { kind: 'color' as const, value: profile.palette.bg }
  return {
    ...base,
    style: {
      ...base.style,
      colors,
      fonts: {
        ...base.style.fonts,
        heading: dedupe([profile.fonts.heading, ...base.style.fonts.heading]),
        body: dedupe([profile.fonts.body, ...base.style.fonts.body]),
      },
      defaultBackgrounds: {
        ...(base.style.defaultBackgrounds ?? {}),
        cover: background,
        chapter: background,
        content: background,
        ending: background,
      },
    },
  }
}
