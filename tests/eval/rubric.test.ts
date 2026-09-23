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
  requireDesignProfile: true,
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
  storyboardPresent: true,
  storyboardProblems: [],
  layoutProblems: [],
  budgetProblems: [],
  chromeDeclared: true,
  chromeProblems: [],
  designProfileOk: true,
  designProfileProblems: [],
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
    const lenient: ScenarioRubric = { ...strict, requireNativeChart: false, requireNativeTable: false, requireAttribution: false, requireCheckpoint: false, requireBrandTheme: false, requireDesignProfile: false }
    const bare: DeckObservation = { ...good, chartParts: [], hasTable: false, attributionPresent: false, checkpointPhase: null, themeFile: null, themeFileExists: false, designProfileOk: null }
    const results = evaluateRubric(lenient, bare)
    expect(results.every((entry) => entry.passed)).toBe(true)
    expect(results.find((entry) => entry.id === 'native-chart')?.message).toBe('not required by this scenario')
    expect(results.find((entry) => entry.id === 'design-profile')?.message).toBe('not required by this scenario')
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

  it('fails the storyboard row when the plan is absent or inconsistent', () => {
    const missing = check({ ...good, storyboardPresent: false }, strict, 'storyboard')
    expect(missing?.passed).toBe(false)
    expect(missing?.message).toContain('no deck.storyboard.json')
    const inconsistent = check({ ...good, storyboardProblems: ['storyboard-coverage: missing page 2'] }, strict, 'storyboard')
    expect(inconsistent?.passed).toBe(false)
    expect(inconsistent?.message).toContain('missing page 2')
  })

  it('fails role-layout and budget on their own findings', () => {
    const layout = check({ ...good, layoutProblems: ['storyboard page 2: role "data" cannot use layout "brief:gauge-next"'] }, strict, 'role-layout')
    expect(layout?.passed).toBe(false)
    expect(layout?.message).toContain('cannot use layout')
    const budget = check({ ...good, budgetProblems: ['page 2 (content): words measured 19, maxWords limit 5'] }, strict, 'budget')
    expect(budget?.passed).toBe(false)
    expect(budget?.message).toContain('measured 19')
  })

  it('fails chrome when the manifest declares none or the audit reports one', () => {
    expect(check({ ...good, chromeDeclared: false }, strict, 'chrome')?.passed).toBe(false)
    expect(check({ ...good, chromeDeclared: false }, strict, 'chrome')?.message).toContain('no chrome block')
    const bad = check({ ...good, chromeProblems: ['chrome-coverage: page 2 has no slidenum field'] }, strict, 'chrome')
    expect(bad?.passed).toBe(false)
    expect(bad?.message).toContain('chrome-coverage')
  })

  it('fails design-profile when the deck carries no profile or the profile audit reports one', () => {
    const absent = check({ ...good, designProfileOk: null }, strict, 'design-profile')
    expect(absent?.passed).toBe(false)
    expect(absent?.message).toContain('no design profile')
    const drift = check({ ...good, designProfileOk: false, designProfileProblems: ['design-role-title-font: content title is 45 pt but the profile says 36 ±1 pt'] }, strict, 'design-profile')
    expect(drift?.passed).toBe(false)
    expect(drift?.message).toContain('45 pt')
  })
})
