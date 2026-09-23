/**
 * Shared OOXML slide-text parsing for the design audit and the design pass.
 *
 * Both the audit (`bridge/design-audit.ts`) and the pass (`bridge/design-pass.ts`)
 * must see exactly the same runs, shapes and geometry, so these helpers live in one
 * place. They mirror what `python-assets/scripts/design-profile.py` sees through
 * python-pptx: top-level `p:sp` shapes only (grouped text is skipped), explicit
 * `sz`/`srgbClr`/typeface on a run for it to count, and the shape's `a:off`/`a:ext`
 * as the geometry.
 */

/** EMU per inch, the unit the profile and both sides of the audit use. */
export const EMU_PER_INCH = 914400

/** One styled text run with its shape geometry, as the extractor sees it. */
export interface SlideRun {
  readonly text: string
  readonly sizePt: number
  readonly bold: boolean
  readonly color: string
  /** Explicit Latin (preferred) or East-Asian typeface; a run without one is not styled. */
  readonly font: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * @param hex - `#RRGGBB`.
 * @returns the extractor's simple weighted luminance (0–1).
 */
export function simpleLuminance(hex: string): number {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}

/** @param hex - `#RRGGBB`. @returns true when the channels differ by at most 0x08. */
export function isGrey(hex: string): boolean {
  const value = hex.startsWith('#') ? hex.slice(1) : hex
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
  return Math.max(...channels) - Math.min(...channels) <= 8
}

/** @param text - one run's text. @returns true for a numeral run such as `02` or `12、`. */
export function isNumberLike(text: string): boolean {
  const stripped = text.trim().replace(/[.．、\s]+$/g, '').replace(/^[.．、\s]+/g, '')
  return /^\d{1,4}$/.test(stripped)
}

/**
 * @param xml - one slide part.
 * @returns the shape XML of top-level `p:sp` shapes. Shapes inside `p:grpSp` are
 *   dropped, matching python-pptx's `slide.shapes` iteration.
 */
export function topLevelShapes(xml: string): string[] {
  const withoutGroups = xml.replace(/<p:grpSp\b[^>]*>[\s\S]*?<\/p:grpSp>/g, '')
  return [...withoutGroups.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((match) => match[0])
}

/** @param shape - one shape block. @returns the shape's `a:off`/`a:ext`, or null when either is absent. */
export function shapeGeometry(shape: string): { x: number; y: number; w: number; h: number } | null {
  const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(shape)
  const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(shape)
  if (off === null || ext === null) return null
  return { x: Number(off[1]), y: Number(off[2]), w: Number(ext[1]), h: Number(ext[2]) }
}

/**
 * @param shape - one `p:sp` block.
 * @returns every run that names an explicit size, colour, typeface and text, as python-pptx sees them.
 */
export function shapeRuns(shape: string): SlideRun[] {
  const geometry = shapeGeometry(shape)
  if (geometry === null) return []
  const runs: SlideRun[] = []
  for (const match of shape.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
    const inner = match[1] ?? ''
    const open = /<a:rPr\b([^>]*)>/.exec(inner)
    const sizeText = open === null ? null : /\bsz="(\d+)"/.exec(open[1] ?? '')
    const color = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(inner)
    const latin = /<a:latin typeface="([^"]*)"/.exec(inner)
    const font = latin?.[1] ?? /<a:ea typeface="([^"]*)"/.exec(inner)?.[1] ?? ''
    const text = [...inner.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((entry) => entry[1] ?? '').join('')
    if (sizeText === null || color === null || font === '' || text.trim() === '') continue
    runs.push({
      text,
      sizePt: Number(sizeText[1]) / 100,
      bold: /\bb="1"/.test(open?.[1] ?? ''),
      color: `#${(color[1] ?? '').toUpperCase()}`,
      font,
      ...geometry,
    })
  }
  return runs
}

/** @param shape - one shape block. @returns its `p:spPr` XML, or an empty string. */
export function shapeProperties(shape: string): string {
  return /<p:spPr\b[^>]*>[\s\S]*?<\/p:spPr>|<p:spPr\b[^>]*\/>/.exec(shape)?.[0] ?? ''
}

/**
 * @param runs - styled runs of one slide.
 * @returns the slide's title run: the largest dark run, ties broken by the smallest y,
 *   matching `design-profile.py`'s per-slide title selection.
 */
export function chooseTitle(runs: readonly SlideRun[]): { run: SlideRun; rest: SlideRun[] } | null {
  const dark = runs.filter((run) => simpleLuminance(run.color) <= 0.75)
  let title: SlideRun | undefined
  let titleIndex = -1
  for (const [index, run] of dark.entries()) {
    if (title === undefined || run.sizePt > title.sizePt || (run.sizePt === title.sizePt && run.y < title.y)) {
      title = run
      titleIndex = index
    }
  }
  if (title === undefined) return null
  return { run: title, rest: dark.filter((_, index) => index !== titleIndex) }
}
