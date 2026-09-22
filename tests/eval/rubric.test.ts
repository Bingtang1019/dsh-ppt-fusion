import { describe, expect, it } from 'vitest'
import { CHECK_IDS, attemptPassed, evaluateRubric, type DeckObservation, type ScenarioRubric } from './rubric.ts'

/** A rubric that asks for every check. */
const strict: ScenarioRubric = {
  minSlides: 4,
  maxSlides: 6,
  requireTextShapes: true,
  requireNativeChart: true,
  requireNativeTable: true,
  requireAttribution: true,
  requireCheckpoint: true,
  requireBrandTheme: true,
}

/** A deck that satisfies `strict`. */
const good: DeckObservation = {
  auditOk: true,
  auditErrorCount: 0,
  auditSkipped: ['pixels'],
  slides: 5,
  slidesWithTextShapes: 5,
  masterCount: 1,
  chartParts: ['ppt/charts/chart1.xml'],
  hasTable: true,
  attributionProblems: [],
  attributionPresent: true,
  checkpointPhase: '6',
  themeFile: 'brand.theme.json',
  themeFileExists: true,
}

/** @returns the check with `id`, or undefined. */
function check(observation: DeckObservation, rubric: ScenarioRubric = strict, id: string = 'audit-pass') {
  return evaluateRubric(rubric, observation).find((entry) => entry.id === id)
}

describe('evaluateRubric', () => {
  it('passes a deck that satisfies every check, in stable order', () => {
    const results = evaluateRubric(strict, good)
    expect(results.map((entry) => entry.id)).toEqual([...CHECK_IDS])
    expect(results.every((entry) => entry.passed)).toBe(true)
  })

  it('fails the audit check when the gate did not run', () => {
    const result = check({ ...good, auditOk: null })
    expect(result?.passed).toBe(false)
    expect(result?.message).toContain('did not run')
  })

  it('fails the slide count outside the requested range', () => {
    expect(check({ ...good, slides: 3 }, strict, 'slide-count')?.passed).toBe(false)
    expect(check({ ...good, slides: 7 }, strict, 'slide-count')?.passed).toBe(false)
    expect(check({ ...good, slides: 4 }, strict, 'slide-count')?.passed).toBe(true)
  })

  it('fails text-shapes when a slide has no native shape', () => {
    expect(check({ ...good, slidesWithTextShapes: 4 }, strict, 'text-shapes')?.passed).toBe(false)
    expect(check({ ...good, slidesWithTextShapes: 4 }, strict, 'text-shapes')?.message).toContain('4 of 5')
  })

  it('passes optional checks with `not required` when the rubric does not ask', () => {
    const lenient: ScenarioRubric = { ...strict, requireNativeChart: false, requireNativeTable: false, requireAttribution: false, requireCheckpoint: false, requireBrandTheme: false }
    const bare: DeckObservation = { ...good, chartParts: [], hasTable: false, attributionPresent: false, checkpointPhase: null, themeFile: null, themeFileExists: false }
    const results = evaluateRubric(lenient, bare)
    expect(results.every((entry) => entry.passed)).toBe(true)
    expect(results.find((entry) => entry.id === 'native-chart')?.message).toBe('not required by this scenario')
  })

  it('fails attribution when an item has no licence or author', () => {
    const result = check({ ...good, attributionProblems: ['item 0 has no author'] }, strict, 'attribution')
    expect(result?.passed).toBe(false)
    expect(result?.message).toContain('item 0 has no author')
  })

  it('fails single-master on a multi-master package', () => {
    expect(check({ ...good, masterCount: 2 }, strict, 'single-master')?.passed).toBe(false)
  })

  it('fails brand-theme when the bound theme file is missing', () => {
    expect(check({ ...good, themeFileExists: false }, strict, 'brand-theme')?.passed).toBe(false)
  })

  it('treats the checkpoint as a warning-level process signal, not a gate', () => {
    const checks = evaluateRubric(strict, { ...good, checkpointPhase: null })
    const checkpoint = checks.find((entry) => entry.id === 'checkpoint')
    expect(checkpoint?.level).toBe('warning')
    expect(checkpoint?.passed).toBe(false)
    expect(attemptPassed(checks)).toBe(true)
    expect(attemptPassed(evaluateRubric(strict, { ...good, slides: 99 }))).toBe(false)
  })
})
