import { DshPptFailure } from '../engine/errors.ts'

/** Schema version of the `text-measure` report. */
export const TEXT_MEASURE_SCHEMA_VERSION = 1

/** One measured single line, as the engine reports it. */
export interface TextMeasurement {
  readonly text: string
  readonly width: number
}

/** One wrapped paragraph, as the engine reports it. */
export interface TextWrap {
  readonly lines: readonly string[]
  readonly widths: readonly number[]
  /** The box width the paragraph was wrapped against. */
  readonly maxWidth: number
  /** Block height in px for the wrapped lines. */
  readonly height: number
}

/** One text item of the CLI report. */
export interface TextMeasureItem {
  readonly text: string
  /** Single-line width for `measure`, widest line for `wrap`. */
  readonly width: number
  readonly lines: readonly string[]
  /** Block height for `wrap`; null for `measure`. */
  readonly height: number | null
}

/** A text box in px. */
export interface TextBox {
  readonly width: number
  readonly height: number
}

/** The `dsh-ppt text-measure` report. */
export interface TextMeasureResult {
  readonly schemaVersion: number
  readonly mode: 'measure' | 'wrap'
  readonly sizePt: number
  readonly family: string | null
  readonly weight: string | null
  /** The box the text was measured against, or null for a single-line measurement. */
  readonly box: TextBox | null
  readonly items: readonly TextMeasureItem[]
  /** True when every item stays inside the box. */
  readonly fits: boolean
  /** Which axes overflow: `x` when a line is wider than the box, `y` when the block is taller. */
  readonly overflow: readonly ('x' | 'y')[]
}

/** @param text - raw engine stdout. @param open - opening delimiter. @param close - closing delimiter. @returns the JSON payload between the outermost delimiters, or null. */
function slicePayload(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  return start < 0 || end < start ? null : text.slice(start, end + 1)
}

/** @param value - candidate. @returns the value when it is a finite number. */
function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * @param stdout - `ppt-master text-measure measure --json` stdout.
 * @returns one measurement per text, in the order the engine reported them.
 * @throws DshPptFailure `ContractViolation` when the payload is absent or malformed.
 */
export function parseMeasureOutput(stdout: string): TextMeasurement[] {
  const payload = slicePayload(stdout, '[', ']')
  if (payload === null) throw new DshPptFailure('ContractViolation', `text-measure wrote no JSON array: ${stdout.trim().slice(0, 200)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new DshPptFailure('ContractViolation', `text-measure wrote unparseable JSON: ${payload.slice(0, 200)}`)
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new DshPptFailure('ContractViolation', 'text-measure measured no text')
  return parsed.map((entry) => {
    const record = entry as { text?: unknown; width?: unknown }
    const width = finiteNumber(record.width)
    if (typeof record.text !== 'string' || width === null) {
      throw new DshPptFailure('ContractViolation', `text-measure returned an unusable measurement: ${JSON.stringify(entry)}`)
    }
    return { text: record.text, width }
  })
}

/**
 * @param stdout - `ppt-master text-measure wrap --json` stdout.
 * @returns the wrapped lines, their widths, the wrapped width and the block height.
 * @throws DshPptFailure `ContractViolation` when the payload is absent or malformed.
 */
export function parseWrapOutput(stdout: string): TextWrap {
  const payload = slicePayload(stdout, '{', '}')
  if (payload === null) throw new DshPptFailure('ContractViolation', `text-measure wrap wrote no JSON object: ${stdout.trim().slice(0, 200)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    throw new DshPptFailure('ContractViolation', `text-measure wrap wrote unparseable JSON: ${payload.slice(0, 200)}`)
  }
  const record = parsed as { lines?: unknown; widths?: unknown; max_width?: unknown; height?: unknown }
  const lines = Array.isArray(record.lines) ? record.lines.filter((line): line is string => typeof line === 'string') : null
  const widths = Array.isArray(record.widths) ? record.widths.map(finiteNumber) : null
  const maxWidth = finiteNumber(record.max_width)
  const height = finiteNumber(record.height)
  if (lines === null || widths === null || widths.some((width) => width === null) || maxWidth === null || height === null) {
    throw new DshPptFailure('ContractViolation', `text-measure wrap returned an unusable payload: ${payload.slice(0, 200)}`)
  }
  return { lines, widths: widths as number[], maxWidth, height }
}

/**
 * Build the CLI report from one engine mode.
 *
 * @param input.mode - `measure` or `wrap`.
 * @param input.sizePt - the size the engine measured at.
 * @param input.family - font family, when given.
 * @param input.weight - font weight, when given.
 * @param input.box - the box the text must fit, when the caller passed one.
 * @param input.measurements - parsed `measure` output.
 * @param input.wrap - parsed `wrap` output.
 * @returns the report, with `fits`/`overflow` computed against the box.
 */
export function buildTextMeasureResult(input: {
  mode: 'measure' | 'wrap'
  sizePt: number
  family?: string
  weight?: string
  box?: TextBox
  measurements?: readonly TextMeasurement[]
  wrap?: TextWrap
}): TextMeasureResult {
  const box = input.box ?? null
  const items: TextMeasureItem[] =
    input.mode === 'wrap'
      ? [
          {
            text: input.wrap?.lines.join('\n') ?? '',
            width: Math.max(0, ...(input.wrap?.widths ?? [])),
            lines: input.wrap?.lines ?? [],
            height: input.wrap?.height ?? null,
          },
        ]
      : (input.measurements ?? []).map((measurement) => ({ text: measurement.text, width: measurement.width, lines: [measurement.text], height: null }))
  const overflow: ('x' | 'y')[] = []
  if (box !== null) {
    // In `measure` mode the reported width is the line itself; in `wrap` mode the
    // block can still overflow horizontally when one unbreakable word is wider
    // than the box, so the per-line widths are the honest signal.
    const tooWide =
      input.mode === 'wrap'
        ? (input.wrap?.widths ?? []).some((width) => width > box.width)
        : items.some((item) => item.width > box.width)
    const tooTall = items.some((item) => item.height !== null && item.height > box.height)
    if (tooWide) overflow.push('x')
    if (tooTall) overflow.push('y')
  }
  return {
    schemaVersion: TEXT_MEASURE_SCHEMA_VERSION,
    mode: input.mode,
    sizePt: input.sizePt,
    family: input.family ?? null,
    weight: input.weight ?? null,
    box,
    items,
    fits: overflow.length === 0,
    overflow,
  }
}
