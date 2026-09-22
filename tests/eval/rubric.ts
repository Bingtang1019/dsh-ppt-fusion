/**
 * Scenario expectations and the pure evaluation of one finished deck.
 *
 * The model eval (plan M6.4-M6.6) runs a scenario through the headless agent and
 * then answers one question per check against the produced workspace. This module
 * owns the check list and stays free of process and filesystem access so the
 * pass/fail rules can be unit-tested without a model.
 */

/** Expectations one scenario declares in `fixtures/scenarios/<name>.yaml`. */
export interface ScenarioRubric {
  readonly minSlides: number
  readonly maxSlides: number
  readonly requireTextShapes: boolean
  readonly requireNativeChart: boolean
  readonly requireNativeTable: boolean
  readonly requireAttribution: boolean
  readonly requireCheckpoint: boolean
  readonly requireBrandTheme: boolean
}

/** One staged input file the harness copies into the scenario workspace. */
export interface ScenarioInput {
  /** Path relative to the repository root. */
  readonly from: string
  /** Destination relative to the scenario workspace. */
  readonly to: string
}

/** One scenario file, validated after YAML parsing. */
export interface ScenarioSpec {
  readonly name: string
  readonly title: string
  readonly maxAttempts: number
  readonly task: string
  readonly inputs: readonly ScenarioInput[]
  readonly rubric: ScenarioRubric
}

/** Everything the checks read from a finished workspace. */
export interface DeckObservation {
  /** `null` when the audit could not be run at all. */
  readonly auditOk: boolean | null
  readonly auditErrorCount: number
  readonly auditSkipped: readonly string[]
  /** Slide count from `out/manifest.json`, or null when nothing was published. */
  readonly slides: number | null
  /** Slides (of the package) that carry at least one `p:sp` shape; null when unreadable. */
  readonly slidesWithTextShapes: number | null
  /** Number of `ppt/slideMasters/*.xml` parts; null when unreadable. */
  readonly masterCount: number | null
  /** `ppt/charts/*.xml` parts whose root element is `c:chartSpace`. */
  readonly chartParts: readonly string[]
  /** Whether any slide XML carries an `a:tbl` table. */
  readonly hasTable: boolean
  /** Problems found in `assets/image_sources.json`, if that file exists. */
  readonly attributionProblems: readonly string[]
  readonly attributionPresent: boolean
  /** `phase` from `.dsh-ppt/checkpoint.json`, or null when absent or unparsable. */
  readonly checkpointPhase: string | null
  /** Theme file the deck manifest binds, or null. */
  readonly themeFile: string | null
  /** Whether that theme file exists under the deck. */
  readonly themeFileExists: boolean
}

/** One evaluated check, before the catalog supplies its severity. */
export interface RubricCheckResult {
  readonly id: string
  /** `error` checks decide the scenario; `warning` checks are recorded process signals. */
  readonly level: 'error' | 'warning'
  readonly passed: boolean
  readonly message: string
}

/** The check ids this module emits, in report order. */
export const CHECK_IDS = [
  'audit-pass',
  'slide-count',
  'text-shapes',
  'single-master',
  'native-chart',
  'native-table',
  'attribution',
  'checkpoint',
  'brand-theme',
] as const

export type CheckId = (typeof CHECK_IDS)[number]

/** Severity per check (mirrors `fixtures/scenarios/rubric.json`). */
export const CHECK_SEVERITY: Readonly<Record<CheckId, 'error' | 'warning'>> = {
  'audit-pass': 'error',
  'slide-count': 'error',
  'text-shapes': 'error',
  'single-master': 'error',
  'native-chart': 'error',
  'native-table': 'error',
  attribution: 'error',
  // Checkpoint use is a process metric (plan M6.4), not a delivery gate.
  checkpoint: 'warning',
  'brand-theme': 'error',
}

/**
 * @param checks - evaluated checks.
 * @returns true when every error-level check passed; warnings never fail a scenario.
 */
export function attemptPassed(checks: readonly RubricCheckResult[]): boolean {
  return checks.every((check) => check.level === 'warning' || check.passed)
}

/**
 * Evaluate every check for one observation.
 *
 * A check that was not requested by the rubric passes with a `not required`
 * message, so a report always carries the same nine rows and differences stay
 * visible without reading the scenario.
 *
 * @param rubric - the scenario's expectations.
 * @param observation - what the finished workspace contains.
 * @returns one result per check id, in `CHECK_IDS` order.
 */
export function evaluateRubric(rubric: ScenarioRubric, observation: DeckObservation): RubricCheckResult[] {
  const results: Record<CheckId, RubricCheckResult> = {
    'audit-pass': pass(
      'audit-pass',
      observation.auditOk === true,
      observation.auditOk === null
        ? 'the audit gate did not run'
        : observation.auditOk
          ? `audit ok (${String(observation.auditSkipped.length)} skipped source(s))`
          : `audit failed with ${String(observation.auditErrorCount)} error(s)`,
    ),
    'slide-count': pass(
      'slide-count',
      observation.slides !== null && observation.slides >= rubric.minSlides && observation.slides <= rubric.maxSlides,
      observation.slides === null
        ? 'no published slide count found'
        : `${String(observation.slides)} slide(s), expected ${String(rubric.minSlides)}-${String(rubric.maxSlides)}`,
    ),
    'text-shapes': toggle(
      'text-shapes',
      rubric.requireTextShapes,
      observation.slides !== null && observation.slidesWithTextShapes === observation.slides,
      `${String(observation.slidesWithTextShapes ?? 0)} of ${String(observation.slides ?? 0)} slide(s) carry a text shape`,
    ),
    'single-master': pass('single-master', observation.masterCount === 1, `${String(observation.masterCount ?? 0)} slide master(s)`),
    'native-chart': toggle(
      'native-chart',
      rubric.requireNativeChart,
      observation.chartParts.length > 0,
      observation.chartParts.length === 0 ? 'no native chart part found' : `native chart part(s): ${observation.chartParts.join(', ')}`,
    ),
    'native-table': toggle('native-table', rubric.requireNativeTable, observation.hasTable, observation.hasTable ? 'native table found' : 'no native table found'),
    attribution: toggle(
      'attribution',
      rubric.requireAttribution || observation.attributionPresent,
      observation.attributionProblems.length === 0,
      observation.attributionProblems.length === 0
        ? observation.attributionPresent
          ? 'image_sources.json records a licence and an author for every image'
          : 'no sourced images in this deck'
        : observation.attributionProblems.join('; '),
    ),
    checkpoint: toggle(
      'checkpoint',
      rubric.requireCheckpoint,
      observation.checkpointPhase !== null,
      observation.checkpointPhase === null ? 'no .dsh-ppt/checkpoint.json found' : `checkpoint phase ${observation.checkpointPhase}`,
    ),
    'brand-theme': toggle(
      'brand-theme',
      rubric.requireBrandTheme,
      observation.themeFile !== null && observation.themeFileExists,
      observation.themeFile === null ? 'the manifest binds no theme file' : `theme file ${observation.themeFile}${observation.themeFileExists ? '' : ' is missing'}`,
    ),
  }
  return CHECK_IDS.map((id) => results[id])
}

/** @returns a check that always runs. */
function pass(id: CheckId, passed: boolean, message: string): RubricCheckResult {
  return { id, level: CHECK_SEVERITY[id], passed, message }
}

/** @returns a check that reports `not required` when the rubric does not ask for it. */
function toggle(id: CheckId, required: boolean, passed: boolean, message: string): RubricCheckResult {
  if (!required) return { id, level: CHECK_SEVERITY[id], passed: true, message: 'not required by this scenario' }
  return { id, level: CHECK_SEVERITY[id], passed, message }
}
