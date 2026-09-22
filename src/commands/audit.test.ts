import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { auditDeck } from './audit.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, ok, type FakeCall, type FakeFileSystem } from '../../tests/support/fake-runner.ts'
import { installFakePptwise } from '../../tests/support/fake-pptwise.ts'

const workspace = join(process.cwd(), 'tmp', 'audit-deck')
const packageDir = join(process.cwd(), 'tmp', 'pptwise-audit')

/** A one-page standard deck whose pptwise answers come from the fake CLI. */
function buildDeck(): { fs: FakeFileSystem; resolveModule: (specifier: string) => string } {
  const fs = createFakeFileSystem({
    files: {
      [join(workspace, 'deck.ir.json')]: JSON.stringify({ version: '5', slides: [{ type: 'cover' }] }),
      [join(workspace, 'deck.fusion.json')]: JSON.stringify({
        version: 1,
        name: 'deck',
        pptwiseIr: 'deck.ir.json',
        theme: { preset: 'brief' },
        pages: [{ index: 1, route: 'pptwise' }],
      }),
    },
  })
  const { resolveModule } = installFakePptwise(fs, { packageDir })
  return { fs, resolveModule }
}

/** A runner that answers the two front-end commands the audit issues. */
function auditRunner(handler: (command: string, call: FakeCall) => ReturnType<typeof ok>) {
  return createFakeRunner((call) => handler(call.args[1] ?? '', call))
}

describe('auditDeck', () => {
  it('maps pptwise validate and audit output into findings and names the missing package', async () => {
    const { fs, resolveModule } = buildDeck()
    const runner = auditRunner((command) => {
      if (command === 'validate') return ok('OK — 1 slides, theme "brief"\n')
      if (command === 'audit') {
        return ok(
          `${JSON.stringify({
            findings: [
              { slide: 1, severity: 'error', code: 'geometry-overflow', message: 'text overflows its box' },
              { slide: 1, severity: 'warn', code: 'contrast-low', message: 'contrast 2.1:1' },
            ],
            pagesAudited: 1,
          })}\n`,
        )
      }
      return ok()
    })
    const report = await auditDeck({ dir: workspace, strict: false, pixels: false, deps: defaultDependencies({ fs, cwd: workspace, runner, resolveModule }) })

    expect(report.sources).toContain('pptwise-validate')
    expect(report.sources).toContain('pptwise-audit')
    expect(report.artifact).toBeNull()
    expect(report.ok).toBe(false)
    const mapped = report.findings.filter((finding) => finding.source === 'pptwise-audit')
    expect(mapped.map((finding) => finding.rule).sort()).toEqual(['contrast-low', 'geometry-overflow'])
    expect(mapped.find((finding) => finding.rule === 'geometry-overflow')?.level).toBe('error')
    expect(mapped.find((finding) => finding.rule === 'contrast-low')?.level).toBe('warning')
    expect(mapped.every((finding) => finding.page === 1)).toBe(true)
    expect(report.findings.some((finding) => finding.rule === 'artifact-missing')).toBe(true)
    expect(report.skipped.join(' ')).toContain('compat-lint')
    expect(report.skipped.join(' ')).toContain('prompt-audit')
    // Findings are ordered errors first.
    expect(report.findings[0]?.level).toBe('error')
  })

  it('turns a failing pptwise validate and a non-zero audit into error findings', async () => {
    const { fs, resolveModule } = buildDeck()
    const runner = auditRunner((command) => {
      if (command === 'validate') return { status: 1, stdout: 'ERROR: slide 1 has no title\n', stderr: '' }
      if (command === 'audit') return { status: 1, stdout: '{"findings": []}\n', stderr: '' }
      return ok()
    })
    const report = await auditDeck({ dir: workspace, strict: false, pixels: false, deps: defaultDependencies({ fs, cwd: workspace, runner, resolveModule }) })

    expect(report.findings.some((finding) => finding.rule === 'pptwise-ir-invalid' && finding.message.includes('no title'))).toBe(true)
    expect(report.findings.some((finding) => finding.rule === 'pptwise-audit-failed')).toBe(true)
  })

  it('records the pixel check as skipped when there is nothing to sample', async () => {
    const { fs, resolveModule } = buildDeck()
    const report = await auditDeck({ dir: workspace, strict: true, pixels: true, deps: defaultDependencies({ fs, cwd: workspace, runner: createFakeRunner(), resolveModule }) })
    expect(report.pixels).toBe(true)
    expect(report.strict).toBe(true)
    expect(report.skipped.join(' ')).toContain('pixels')
    expect(report.skipped.join(' ')).toContain('prompt-audit')
  })
})
