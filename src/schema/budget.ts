import { effectiveBudget, type Storyboard, type StoryboardBudget, type StoryboardRole } from './storyboard.ts'

/**
 * Content budgets (plan §4.3).
 *
 * `validate` measures every page the same way this module does and compares the
 * numbers with the page's declared budget, falling back to the per-role defaults.
 * Counting is deliberately structural rather than linguistic: pptwise pages are
 * measured from the IR slide, deep pages from their authored SVG.
 */

/** What one page holds. */
export interface PageMeasurement {
  readonly words: number
  readonly items: number
  readonly charts: number
  readonly tables: number
  readonly images: number
}

/** Budget fields, in the order findings report them. */
export const BUDGET_DIMENSIONS = ['maxWords', 'maxItems', 'maxCharts', 'maxTables', 'maxImages'] as const

/** One budget field. */
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number]

/** Which measurement a budget field compares against. */
export const MEASURED_BY_DIMENSION: Record<BudgetDimension, keyof PageMeasurement> = {
  maxWords: 'words',
  maxItems: 'items',
  maxCharts: 'charts',
  maxTables: 'tables',
  maxImages: 'images',
}

/** IR keys whose strings are visible prose. */
const TEXT_KEYS = new Set(['heading', 'subheading', 'kicker', 'title', 'text', 'paragraph', 'caption', 'label', 'value', 'quote', 'note', 'body'])

/** IR keys whose arrays are discrete on-slide items. */
const ITEM_KEYS = new Set(['items', 'bullets', 'cards', 'steps', 'points', 'entries'])

const CHART_TYPES = /chart|kpi|gauge|spark|stat|metric/
const TABLE_TYPES = /table|grid/
const IMAGE_TYPES = /image|photo|figure|picture|logo/

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u
const CJK_GLOBAL = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu
const NOT_WORD = /[^\p{L}\p{N}]+/gu

/**
 * Count words in one string.
 *
 * Whitespace separates words; a run of CJK characters counts per character
 * because the language has no spaces, and the remaining letters or digits in a
 * token count as one word.
 *
 * @param text - text as authored.
 * @returns the word count.
 */
export function countWords(text: string): number {
  let total = 0
  for (const token of text.split(/\s+/)) {
    if (token === '') continue
    const cjk = [...token].filter((char) => CJK.test(char)).length
    const rest = token.replace(CJK_GLOBAL, '').replace(NOT_WORD, '')
    total += cjk + (rest === '' ? 0 : 1)
  }
  return total
}

/**
 * Measure a pptwise IR slide.
 *
 * Prose comes from the known text keys; table and chart payload labels (axis,
 * series, cells) are native-object data, not narrative copy, so they do not count
 * as words. Items are the entries of the known item arrays; charts, tables and
 * images are components whose type names them.
 *
 * @param slide - the raw IR slide, whatever keys it carries.
 * @returns the page's counts.
 */
export function measureIrSlide(slide: unknown): PageMeasurement {
  const measurement = { words: 0, items: 0, charts: 0, tables: 0, images: 0 }
  walk(slide, undefined, measurement)
  return measurement
}

/** Mutable accumulator; `PageMeasurement` is the read-only face of the same numbers. */
type Counting = { words: number; items: number; charts: number; tables: number; images: number }

function walk(node: unknown, key: string | undefined, counting: Counting): void {
  if (typeof node === 'string') {
    if (key !== undefined && TEXT_KEYS.has(key)) counting.words += countWords(node)
    return
  }
  if (Array.isArray(node)) {
    const itemKey = key !== undefined && ITEM_KEYS.has(key)
    const textKey = key !== undefined && TEXT_KEYS.has(key)
    if (itemKey) counting.items += node.length
    for (const entry of node) {
      if (typeof entry === 'string') {
        if (itemKey || textKey) counting.words += countWords(entry)
      } else {
        walk(entry, undefined, counting)
      }
    }
    return
  }
  if (node === null || typeof node !== 'object') return
  const record = node as Record<string, unknown>
  if (typeof record.type === 'string') classify(record.type, counting)
  for (const [childKey, value] of Object.entries(record)) walk(value, childKey, counting)
}

function classify(type: string, counting: Counting): void {
  const lower = type.toLowerCase()
  if (TABLE_TYPES.test(lower)) counting.tables += 1
  else if (CHART_TYPES.test(lower)) counting.charts += 1
  else if (IMAGE_TYPES.test(lower)) counting.images += 1
}

/**
 * Measure an authored deep page.
 *
 * Words are the `<text>` elements' contents; charts and tables are the
 * `data-pptx-replace-with` markers the engine turns into native objects; images
 * are the marker plus any `<image>` element. Items have no deep-page equivalent,
 * so they stay zero.
 *
 * @param svg - the page's `page.svg`.
 * @returns the page's counts.
 */
export function measureDeepSvg(svg: string): PageMeasurement {
  const measurement = { words: 0, items: 0, charts: 0, tables: 0, images: 0 }
  for (const match of svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)) measurement.words += countWords(decodeXml(match[1] ?? ''))
  for (const match of svg.matchAll(/data-pptx-replace-with\s*=\s*"([^"]*)"/gi)) classify(match[1] ?? '', measurement)
  measurement.images += [...svg.matchAll(/<image\b/gi)].length
  return measurement
}

/** Strip nested markup and the XML entities that carry visible text. */
function decodeXml(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity] ?? ' ')
}

/** One page whose measured content exceeds its budget. */
export interface BudgetViolation {
  readonly page: number
  readonly role: StoryboardRole
  readonly dimension: BudgetDimension
  readonly measured: number
  readonly limit: number
}

/**
 * @param violation - one over-budget page.
 * @returns the message `validate` reports, naming page, role, measurement and limit.
 */
export function formatBudgetViolation(violation: BudgetViolation): string {
  return `page ${String(violation.page)} (${violation.role}): ${MEASURED_BY_DIMENSION[violation.dimension]} measured ${String(violation.measured)}, ${violation.dimension} limit ${String(violation.limit)}`
}

/**
 * Compare every page's measurement with its effective budget.
 *
 * @param storyboard - parsed storyboard whose pages declare the budgets.
 * @param measurements - per-page measurements keyed by 1-based page index; a page
 *   with no measurement is skipped (its absence is another gate's finding).
 * @returns one violation per over-budget field.
 */
export function checkBudgets(storyboard: Storyboard, measurements: ReadonlyMap<number, PageMeasurement>): BudgetViolation[] {
  const violations: BudgetViolation[] = []
  for (const page of storyboard.pages) {
    const measurement = measurements.get(page.index)
    if (measurement === undefined) continue
    const budget: Required<StoryboardBudget> = effectiveBudget(page)
    for (const dimension of BUDGET_DIMENSIONS) {
      const limit = budget[dimension]
      const measured = measurement[MEASURED_BY_DIMENSION[dimension]]
      if (measured > limit) violations.push({ page: page.index, role: page.role, dimension, measured, limit })
    }
  }
  return violations
}
