import { describe, expect, it } from 'vitest'
import { readRecordedLog } from './support/recorded-logs.ts'
import { parseCreatedProjectDir } from '../src/engine/contracts.ts'
import { parsePostflight } from '../src/engine/deep-render.ts'

/**
 * Replay the engine transcripts recorded during the M3 acceptance run
 * (`fixtures/engine/`, produced by a real `dsh-ppt deep render` on this machine).
 *
 * These are the contract tests the milestone asks for: the parsers that read the
 * engine's output are exercised against the exact bytes a real run wrote, so a
 * wording change upstream shows up here instead of in a broken render.
 */
describe('recorded engine transcripts', () => {
  it('every recording is a successful engine invocation', () => {
    for (const name of ['project-init.log', 'stamp-native-fallbacks.log', 'svg-quality-check.log', 'svg-to-pptx.log']) {
      const log = readRecordedLog(name)
      expect(log.status, name).toBe(0)
      expect(log.outcome, name).toBe('ok')
      expect(log.argv.length, name).toBeGreaterThan(1)
    }
  })

  it('project init still prints the created directory in the parsed shape', () => {
    const log = readRecordedLog('project-init.log')
    const created = parseCreatedProjectDir(log.stdout)
    expect(created).not.toBeNull()
    expect(created).toMatch(/deep-p02-p03_ppt169_\d{8}$/)
  })

  it('the quality step still records its report where the contract expects it', () => {
    const log = readRecordedLog('svg-quality-check.log')
    expect(log.argv).toContain('--stage')
    expect(log.argv).toContain('final')
    expect(log.argv).toContain('--canonical-authoring')
    expect(log.stdout).toMatch(/\[REPORT\] JSON quality report exported: .*validation[\\/]svg_quality_report\.json/)
    expect(log.stdout).toContain('With errors: 0')
  })

  it('the export receipt parses into the fields the manifest will record', () => {
    const log = readRecordedLog('svg-to-pptx.log')
    const receipt = parsePostflight(log.stdout)
    expect(receipt).toEqual({ status: 'passed-with-warnings', qualityGate: 'passed', slides: 2, warningCategories: 1 })
  })

  it('the export still writes its report inside the project it exported', () => {
    const log = readRecordedLog('svg-to-pptx.log')
    const reportLine = /\[REPORT\] (.+)$/m.exec(log.stdout)?.[1]?.trim() ?? ''
    expect(reportLine).toMatch(/\.dsh-ppt[\\/]deep[\\/].+[\\/]validation[\\/]deep-batch\.report\.json$/)
  })

  it('the export was invoked with the flags the deep contract requires', () => {
    const log = readRecordedLog('svg-to-pptx.log')
    for (const flag of ['--quick-generate', '--native-charts-and-tables', '--with-notes']) {
      expect(log.argv, flag).toContain(flag)
    }
  })

  it('the stamp step ran in write mode before the quality gate', () => {
    const log = readRecordedLog('stamp-native-fallbacks.log')
    expect(log.argv).toContain('--write')
    expect(log.stdout).toContain('Native fallback baselines')
  })
})
