import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type { DshPptFailure } from './engine/errors.ts'
import { isDshPptFailure } from './engine/errors.ts'
import { createFrontend, parseJsonPayload, resolvePptwiseCli } from './frontend.ts'
import { createFakeRunner, fail, ok, spawnFailed, timedOut } from '../tests/support/fake-runner.ts'

const workspace = join(process.cwd(), 'tmp', 'hello')
const cli = {
  packageDir: join(process.cwd(), 'tmp', 'pptwise'),
  cliPath: join(process.cwd(), 'tmp', 'pptwise', 'dist', 'cli.js'),
  version: '0.35.0',
}

const frontendWith = (runner: ReturnType<typeof createFakeRunner>, env: NodeJS.ProcessEnv = {}) =>
  createFrontend({ cli, workspace, runner, nodeExe: 'node', env })

describe('resolvePptwiseCli', () => {
  it('resolves the package manifest into a CLI path and version', () => {
    const resolved = resolvePptwiseCli({
      resolve: () => 'file:///C:/plugins/pptwise/package.json',
      readText: (path) =>
        path.endsWith('package.json') ? JSON.stringify({ name: '@liustack/pptwise', version: '0.35.0' }) : '// cli',
    })
    expect(resolved.version).toBe('0.35.0')
    expect(resolved.cliPath.endsWith(join('dist', 'cli.js'))).toBe(true)
  })

  it('reports a missing package instead of throwing a resolution error', () => {
    expect(() =>
      resolvePptwiseCli({
        resolve: () => {
          throw new Error('ERR_MODULE_NOT_FOUND')
        },
        readText: () => '',
      }),
    ).toThrowError(/PptwiseMissing|not installed/)
  })

  it('reports a missing CLI entry', () => {
    try {
      resolvePptwiseCli({
        resolve: () => 'file:///C:/plugins/pptwise/package.json',
        readText: (path) => {
          if (path.endsWith('package.json')) return JSON.stringify({ version: '0.35.0' })
          throw new Error('ENOENT')
        },
      })
      expect.unreachable('expected a failure')
    } catch (error) {
      expect(isDshPptFailure(error)).toBe(true)
      expect((error as DshPptFailure).code).toBe('PptwiseMissing')
    }
  })
})

describe('parseJsonPayload', () => {
  it('parses a clean document', () => {
    expect(parseJsonPayload<{ a: number }>('{"a":1}', 'test')).toEqual({ a: 1 })
  })

  it('parses a document surrounded by progress lines', () => {
    expect(parseJsonPayload<{ a: number }>('[SCAN] working\n{"a":2}\n[REPORT] done\n', 'test')).toEqual({ a: 2 })
  })

  it('fails with the captured tail when no JSON is present', () => {
    try {
      parseJsonPayload('no json here', 'pptwise audit')
      expect.unreachable('expected a failure')
    } catch (error) {
      expect((error as DshPptFailure).code).toBe('PptwiseFailed')
      expect((error as DshPptFailure).message).toContain('pptwise audit')
    }
  })
})

describe('frontend commands', () => {
  it('runs the CLI through node with the workspace as cwd and no inherited credentials', () => {
    const runner = createFakeRunner(() => ok('OK — 5 slides, theme "brief"'))
    frontendWith(runner, { DEEPSEEK_API_KEY: 'secret', PATH: '/usr/bin' }).validate('deck.ir.json')
    const call = runner.calls[0]
    expect(call?.command).toBe('node')
    expect(call?.args[0]).toBe(cli.cliPath)
    expect(call?.args.slice(1)).toEqual(['validate', 'deck.ir.json'])
    expect(call?.options.cwd).toBe(workspace)
    expect(call?.options.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(call?.options.env.PATH).toBe('/usr/bin')
  })

  it('treats validate exit 1 as data, not as a tool failure', () => {
    const runner = createFakeRunner(() => fail(1, 'invalid IR (1 issue): page 2 bullet too long'))
    const result = frontendWith(runner).validate('deck.ir.json')
    expect(result.ok).toBe(false)
    expect(result.status).toBe(1)
    expect(result.data.message).toContain('invalid IR')
  })

  it('reports a render gate failure with the stderr tail', () => {
    const runner = createFakeRunner(() => fail(1, 'export stopped: marker is not bound'))
    try {
      frontendWith(runner).render('deck.ir.json', { draft: true, output: 'out/deck.pptx' })
      expect.unreachable('expected a failure')
    } catch (error) {
      expect((error as DshPptFailure).code).toBe('PptwiseFailed')
      expect((error as DshPptFailure).message).toContain('marker is not bound')
    }
  })

  it('returns the audit report even when findings make it exit 1', () => {
    const report = { findings: [{ page: 4, code: 'content-truncated', message: 'text was truncated' }], pagesAudited: 5 }
    const runner = createFakeRunner(() => fail(1, '', JSON.stringify(report)))
    const result = frontendWith(runner).audit('deck.ir.json')
    expect(result.ok).toBe(false)
    expect(result.data.findings).toHaveLength(1)
    expect(result.data.findings?.[0]?.code).toBe('content-truncated')
  })

  it('classifies a timeout and a spawn failure', () => {
    expect(() => frontendWith(createFakeRunner(() => timedOut())).render('deck.ir.json')).toThrowError(/EngineTimeout|exceeded/)
    expect(() => frontendWith(createFakeRunner(() => spawnFailed())).validate('deck.ir.json')).toThrowError(/SpawnFailed|cannot start/)
  })

  it('asks theme new for an id when one is given and returns the written path', () => {
    const runner = createFakeRunner(() => ok('wrote theme.json'))
    const result = frontendWith(runner).themeNew({ from: 'brief', output: 'theme.json', id: 'acme' })
    expect(runner.calls[0]?.args.slice(1)).toEqual(['theme', 'new', '--from', 'brief', '-o', 'theme.json', '--id', 'acme'])
    expect(result.outputFile).toBe(join(workspace, 'theme.json'))
  })

  it('parses the audited deck path out of a render receipt', () => {
    const runner = createFakeRunner(() =>
      ok(`wrote ${join(workspace, 'out', 'hello.pptx')} (5 slides, 30762 bytes)`),
    )
    const result = frontendWith(runner).render('deck.ir.json', { output: 'out/hello.pptx' })
    expect(result.outputFile).toBe(join(workspace, 'out', 'hello.pptx'))
  })
})
