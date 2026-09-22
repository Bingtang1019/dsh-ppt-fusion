import { z } from 'zod'

/**
 * The theme token groups this package treats as the palette contract.
 *
 * pptwise ships a v2 ThemeFile whose style groups live under `style.*` (ADR-012).
 * The group members are copied verbatim; optional members are absent for some
 * factory presets (for example `panel`, `cardStroke`, `emphasisInk`).
 */
export interface ThemeColors {
  bg: string
  surface: string
  panel?: string
  primary: string
  accent: string
  text: string
  muted: string
  border: string
  chartPalette: string[]
  accentPool?: string[]
  cardStroke?: string
  emphasisInk?: string
  danger?: string
  warning?: string
  success?: string
}

/** Font stacks per role. Every role is a list of family names, ordered by preference. */
export interface ThemeFonts {
  heading: string[]
  body: string[]
  /** Monospaced stack; present only for themes that need code or figures. */
  mono?: string[]
}

/** Shape tokens; upstream may add keys, so the type stays open. */
export interface ThemeShape {
  radius?: number
  gapScale?: number
  [key: string]: unknown
}

/**
 * One default page background.
 *
 * `kind` discriminates the payload; a colour carries `value`, while other kinds
 * (a gradient or an image) carry their own fields, so everything beyond `kind`
 * stays open and only a string `value` contributes a palette literal.
 */
export interface ThemeBackground {
  kind: string
  value?: string
  [key: string]: unknown
}

/** A pptwise ThemeFile v2, with the known fields typed and unknown ones preserved. */
export interface ThemeFile {
  id: string
  label?: string
  style: {
    id?: string
    colors: ThemeColors
    fonts: ThemeFonts
    shape?: ThemeShape
    defaultBackgrounds?: Record<string, ThemeBackground>
  }
  occasions?: string[]
  identity?: string
  story?: unknown
  emphasis?: unknown
  version?: number
  menu?: unknown
  [key: string]: unknown
}

const StyleColorsSchema = z.object({
  bg: z.string(),
  surface: z.string(),
  panel: z.string().optional(),
  primary: z.string(),
  accent: z.string(),
  text: z.string(),
  muted: z.string(),
  border: z.string(),
  chartPalette: z.array(z.string()),
  accentPool: z.array(z.string()).optional(),
  cardStroke: z.string().optional(),
  emphasisInk: z.string().optional(),
  danger: z.string().optional(),
  warning: z.string().optional(),
  success: z.string().optional(),
})

const StyleFontsSchema = z.object({
  heading: z.array(z.string()),
  body: z.array(z.string()),
  mono: z.array(z.string()).optional(),
})

const ThemeFileSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  style: z.object({
    id: z.string().optional(),
    colors: StyleColorsSchema,
    fonts: StyleFontsSchema,
    shape: z.record(z.string(), z.unknown()).optional(),
    defaultBackgrounds: z.record(z.string(), z.object({ kind: z.string(), value: z.string().optional() })).optional(),
  }),
  occasions: z.array(z.string()).optional(),
  identity: z.string().optional(),
  version: z.union([z.number(), z.string()]).optional(),
})

/** Schema version of the exported token file. */
export const TOKENS_SCHEMA = 'dsh-ppt-fusion.tokens.v1'

/** Where a token file came from. */
export interface TokenSource {
  readonly kind: 'preset' | 'file'
  readonly preset?: string
  readonly path?: string
  /** Upstream pptwise version the theme came from, recorded for later diffing. */
  readonly upstream?: string
}

/** The exported palette contract the deep pages and the audit both read. */
export interface TokensFile {
  readonly schema: typeof TOKENS_SCHEMA
  readonly themeId: string
  readonly source: TokenSource
  readonly colors: ThemeColors
  readonly fonts: ThemeFonts
  readonly shape: ThemeShape
  readonly defaultBackgrounds: Record<string, ThemeBackground>
}

/**
 * Validate a ThemeFile document.
 *
 * The returned value is the caller's original object, so upstream fields this
 * package does not model (`menu`, `story`, `emphasis`, future additions) survive
 * into anything derived from it.
 *
 * @param raw - parsed JSON of a theme file.
 * @returns the same object, typed.
 * @throws ZodError when the document is not a ThemeFile v2.
 */
export function parseThemeFile(raw: unknown): ThemeFile {
  ThemeFileSchema.parse(raw)
  return raw as ThemeFile
}

/**
 * Project a ThemeFile onto the token groups deep pages consume.
 *
 * @param theme - validated theme file.
 * @param source - where the theme came from, recorded in the export.
 * @returns the token file written to `<deck>/tokens.json`.
 */
export function exportTokens(theme: ThemeFile, source: TokenSource): TokensFile {
  return {
    schema: TOKENS_SCHEMA,
    themeId: theme.id,
    source,
    colors: { ...theme.style.colors, chartPalette: [...theme.style.colors.chartPalette] },
    fonts: { ...theme.style.fonts, heading: [...theme.style.fonts.heading], body: [...theme.style.fonts.body] },
    shape: { ...(theme.style.shape ?? {}) },
    defaultBackgrounds: { ...(theme.style.defaultBackgrounds ?? {}) },
  }
}

/**
 * Every literal a deep page may paint with, in uppercase `#RRGGBB`.
 *
 * This single list is what the palette audit checks against and what
 * `master-design.json` shows the model, so the two can never disagree.
 *
 * @param tokens - exported token file.
 * @returns distinct uppercase hex literals.
 */
export function allowedPalette(tokens: TokensFile): string[] {
  const values = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value)) values.add(value.toUpperCase())
  }
  for (const value of Object.values(tokens.colors)) {
    if (Array.isArray(value)) for (const entry of value) add(entry)
    else add(value)
  }
  // Backgrounds are not always a single colour: the ledger and terminal presets
  // carry `{kind: "gradient", from, to, direction}`, and both stops are legitimate
  // paint literals for a deep page on those themes.
  for (const background of Object.values(tokens.defaultBackgrounds)) {
    for (const value of Object.values(background)) add(value)
  }
  return [...values].sort()
}

/** The model-facing palette file written by `tokens export --master`. */
export interface MasterDesign {
  readonly schema: 'dsh-ppt-fusion.master-design.v1'
  readonly themeId: string
  readonly slideBackground: string
  readonly cardFill: string
  readonly structure: string
  readonly accent: string
  readonly bodyText: string
  readonly secondaryText: string
  readonly line: string
  readonly dataSeries: string[]
  readonly fonts: ThemeFonts
  readonly shape: ThemeShape
  readonly palette: string[]
  readonly guidance: string
}

/**
 * Map token groups onto the names the deep-page authoring guide uses.
 *
 * The plan fixes this mapping (bg, surface, primary, accent, text, muted, border,
 * chartPalette), so deep page authors and the audit share one vocabulary.
 *
 * @param tokens - exported token file.
 * @returns the master design document.
 */
export function masterDesign(tokens: TokensFile): MasterDesign {
  return {
    schema: 'dsh-ppt-fusion.master-design.v1',
    themeId: tokens.themeId,
    slideBackground: tokens.colors.bg,
    cardFill: tokens.colors.surface,
    structure: tokens.colors.primary,
    accent: tokens.colors.accent,
    bodyText: tokens.colors.text,
    secondaryText: tokens.colors.muted,
    line: tokens.colors.border,
    dataSeries: [...tokens.colors.chartPalette],
    fonts: { ...tokens.fonts },
    shape: { ...tokens.shape },
    palette: allowedPalette(tokens),
    guidance:
      'Deep page SVGs must paint only with these literals. Use slideBackground for the page frame, cardFill for panels, structure for headings and primary shapes, accent for emphasis, bodyText and secondaryText for copy, line for rules, and dataSeries for chart series in order.',
  }
}

/**
 * Canonical comparison for token files, used to decide whether a re-export is a
 * change (`theme ensure` is idempotent: a second run writes nothing).
 *
 * @param left - first token document.
 * @param right - second token document.
 * @returns true when both serialize identically.
 */
export function tokensEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortKeys(left)) === JSON.stringify(sortKeys(right))
}

/** Recursively sort object keys so comparisons ignore key order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeys(entry)]))
  }
  return value
}
