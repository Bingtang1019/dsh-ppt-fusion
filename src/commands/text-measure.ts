import { DshPptFailure } from '../engine/errors.ts'
import { engineFor, resolveDeckDir, type CommandDependencies } from './context.ts'
import { buildTextMeasureResult, parseMeasureOutput, parseWrapOutput, type TextBox, type TextMeasureResult } from '../bridge/text-measure.ts'

/** Options for `dsh-ppt text-measure`. */
export interface TextMeasureCommandOptions {
  /** Text to measure; several entries batch the single-line mode. */
  readonly texts: readonly string[]
  /** Workspace whose engine venv and logs are used; the text itself is deck-independent. */
  readonly dir: string
  /** Font size in points. */
  readonly sizePt: number
  readonly family?: string
  readonly weight?: string
  /** Letter spacing in px. */
  readonly letterSpacing?: number
  /** Box to wrap against; without it each text is measured as one line. */
  readonly box?: TextBox
  /** Line advance for `--box`; defaults to `1.2 × size`. */
  readonly lineHeight?: number
  readonly deps: CommandDependencies
}

/**
 * @param value - a `WxH` box in px.
 * @returns the parsed box.
 * @throws DshPptFailure `UsageError` when the value is not two positive numbers.
 */
export function parseBoxOption(value: string): TextBox {
  const match = /^(\d+(?:\.\d+)?)[x×](\d+(?:\.\d+)?)$/.exec(value.trim())
  if (match === null) throw new DshPptFailure('UsageError', `--box must look like 300x60, got ${JSON.stringify(value)}`)
  const width = Number(match[1])
  const height = Number(match[2])
  if (!(width > 0) || !(height > 0)) throw new DshPptFailure('UsageError', `--box sides must be positive, got ${JSON.stringify(value)}`)
  return { width, height }
}

/**
 * Measure text with the engine's DrawingML estimator.
 *
 * Without `--box` every argument is measured as a single line in one batch; with
 * `--box` the arguments join into one paragraph that is wrapped against the box,
 * and the report says whether it fits or overflows on either axis.
 *
 * @param options - texts, size, font attributes, the optional box and dependencies.
 * @returns the measurement report.
 * @throws DshPptFailure `UsageError` when no text is given, and the engine
 *   failures (`VenvMissing`, `EngineExit`, `ContractViolation`) from the measurement run.
 */
export function textMeasureCommand(options: TextMeasureCommandOptions): TextMeasureResult {
  const texts = options.texts.map((text) => text.trim()).filter((text) => text !== '')
  if (texts.length === 0) throw new DshPptFailure('UsageError', 'text-measure needs at least one text argument')
  const dir = resolveDeckDir(options.deps, options.dir)
  const engine = engineFor(dir, options.deps)
  const attributes = {
    sizePt: options.sizePt,
    ...(options.family === undefined ? {} : { family: options.family }),
    ...(options.weight === undefined ? {} : { weight: options.weight }),
    ...(options.letterSpacing === undefined ? {} : { letterSpacing: options.letterSpacing }),
  }
  const box = options.box ?? null
  if (box === null) {
    const call = engine.textMeasure({ mode: 'measure', texts, ...attributes })
    return buildTextMeasureResult({ mode: 'measure', measurements: parseMeasureOutput(call.result.stdout), ...attributes })
  }
  const dy = options.lineHeight ?? Math.round(options.sizePt * 1.2)
  const call = engine.textMeasure({ mode: 'wrap', texts: [texts.join(' ')], maxWidth: box.width, x: 0, dy, ...attributes })
  return buildTextMeasureResult({ mode: 'wrap', wrap: parseWrapOutput(call.result.stdout), box, ...attributes })
}

/**
 * @param result - a `text-measure` report.
 * @returns one header line, one line per item and the box verdict.
 */
export function formatTextMeasureResult(result: TextMeasureResult): string {
  const font = [result.family, result.weight].filter((value): value is string => value !== null && value !== '').join(' ')
  const lines = [`text-measure: ${String(result.items.length)} item(s) at ${String(result.sizePt)} pt${font === '' ? '' : ` ${font}`}`]
  for (const item of result.items) {
    const height = item.height === null ? '' : `, ${item.height.toFixed(1)} px high`
    const wrapped = item.lines.length > 1 ? `, ${String(item.lines.length)} line(s)` : ''
    lines.push(`  "${item.text.length > 60 ? `${item.text.slice(0, 57)}…` : item.text}" ${item.width.toFixed(1)} px${wrapped}${height}`)
  }
  if (result.box === null) lines.push('no --box given: single-line measurements only')
  else if (result.fits) lines.push(`box ${String(result.box.width)}x${String(result.box.height)}: fits`)
  else lines.push(`box ${String(result.box.width)}x${String(result.box.height)}: overflow ${result.overflow.join('+')}`)
  return lines.join('\n')
}
