import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { formatSkillAuditReport, runSkillAudit } from './skill.ts'
import { defaultDependencies } from './context.ts'
import { createFakeFileSystem, createFakeRunner, fail, ok, type FakeRunner } from '../../tests/support/fake-runner.ts'
import type { RunResult } from '../engine/runner.ts'
import { installFakeVenv } from '../../tests/support/fake-venv.ts'

const root = join(process.cwd(), 'tmp', 'skill-audit')
const dshHome = join(process.cwd(), 'tmp', 'skill-audit-dsh')

/** @returns one engine report, with the fields under test overridden. */
function engineReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    summary: { files: 24, tokens: 108984, max_tokens: 120000, errors: 0, warnings: 0 },
    findings: [],
    ...overrides,
  })
}

/** @returns dependencies whose engine answers `prompt-audit` with `answer`. */
function build(answer: () => Partial<RunResult>): { runner: FakeRunner; deps: ReturnType<typeof defaultDependencies> } {
  const fs = createFakeFileSystem({ directories: [root] })
  installFakeVenv(fs, { dshHome })
  const runner = createFakeRunner((call) => (call.args[0] === 'prompt-audit' ? answer() : ok()))
  return { runner, deps: defaultDependencies({ fs, cwd: root, env: { DSH_HOME: dshHome }, runner }) }
}

describe('runSkillAudit', () => {
  it('runs the engine budget gate and reports the summary', () => {
    const { runner, deps } = build(() => ok(engineReport()))
    const report = runSkillAudit({ strict: false, deps, root, manifest: 'audit-manifest.json' })

    expect(report.ok).toBe(true)
    expect(report).toMatchObject({ files: 24, tokens: 108984, maxTokens: 120000, errors: 0, warnings: 0, findings: [] })
    const call = runner.calls[0]
    expect(call?.args).toEqual(['prompt-audit', '--root', root, '--manifest', 'audit-manifest.json', '--json'])
    expect(call?.options.cwd).toBe(root)
  })

  it('recovers the report from the engine exit code of a failing audit', () => {
    const { deps } = build(() =>
      fail(
        1,
        '',
        engineReport({
          summary: { files: 24, tokens: 130000, max_tokens: 120000, errors: 1, warnings: 0 },
          findings: [{ severity: 'error', code: 'TOTAL_BUDGET_EXCEEDED', message: 'corpus exceeds 120000 tokens', path: '', line: 0 }],
        }),
      ),
    )
    const report = runSkillAudit({ strict: false, deps, root })

    expect(report.ok).toBe(false)
    expect(report.errors).toBe(1)
    expect(report.findings).toEqual([
      { level: 'error', code: 'TOTAL_BUDGET_EXCEEDED', message: 'corpus exceeds 120000 tokens', path: '', line: 0 },
    ])
  })

  it('fails a warning-only audit only under --strict', () => {
    const warningReport = engineReport({
      summary: { files: 24, tokens: 108984, max_tokens: 120000, errors: 0, warnings: 1 },
      findings: [{ severity: 'warning', code: 'DUPLICATE_EXACT_CANDIDATES', message: 'Found 1 cross-file exact paragraph groups', path: '', line: 0 }],
    })
    const lenient = runSkillAudit({ strict: false, deps: build(() => ok(warningReport)).deps, root })
    const strict = runSkillAudit({ strict: true, deps: build(() => ok(warningReport)).deps, root })

    expect(lenient.ok).toBe(true)
    expect(strict.ok).toBe(false)
    expect(formatSkillAuditReport(strict)).toContain('FAIL (--strict)')
  })

  it('reports an engine setup envelope as an EngineExit failure', () => {
    const { deps } = build(() => fail(1, '', JSON.stringify({ schema_version: 1, error: { code: 'AUDIT_SETUP_ERROR', message: 'manifest not found' } })))
    expect(() => runSkillAudit({ strict: false, deps, root })).toThrowError(/AUDIT_SETUP_ERROR manifest not found/)
  })

  it('reports a non-JSON answer as an OutputMissing failure', () => {
    const { deps } = build(() => ok('not json\n'))
    expect(() => runSkillAudit({ strict: false, deps, root })).toThrowError(/did not print a JSON report/)
  })

  it('renders one line per finding with the file and line', () => {
    const { deps } = build(() =>
      ok(
        engineReport({
          findings: [{ severity: 'error', code: 'REFERENCE_MISSING', message: 'Markdown target does not exist: ../x.md', path: 'docs/a.md', line: 8 }],
        }),
      ),
    )
    const report = runSkillAudit({ strict: false, deps, root })
    expect(formatSkillAuditReport(report)).toContain('[ERROR] REFERENCE_MISSING docs/a.md:8: Markdown target does not exist: ../x.md')
  })
})
