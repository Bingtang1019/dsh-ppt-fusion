import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createMasterEngine } from './master.ts'
import { DshPptFailure } from './errors.ts'
import { createVenvManager, venvPaths } from './venv.ts'
import { createWorkspaceLogSink } from '../logging.ts'
import { createFakeFileSystem, createFakeRunner, fail, ok, timedOut, type FakeFileSystem } from '../../tests/support/fake-runner.ts'

const workspace = join(process.cwd(), 'tmp', 'deck')
const dshHome = join(process.cwd(), 'tmp', 'dsh-home')
const engineVersion = '0.1.128'
const paths = venvPaths(dshHome, engineVersion, '3.13')

/** A filesystem with a healthy engine venv installed. */
function healthyFileSystem(): FakeFileSystem {
  return createFakeFileSystem({
    files: {
      [paths.pythonExe]: 'binary',
      [paths.engineExe]: 'binary',
      [join(paths.sitePackages, 'ppt_master-0.1.128.dist-info', 'METADATA')]: 'Name: ppt-master\nVersion: 0.1.128\n',
    },
    directories: [paths.root],
  })
}

function buildEngine(options: { runner: ReturnType<typeof createFakeRunner>; fs?: FakeFileSystem; log?: boolean }) {
  const fs = options.fs ?? healthyFileSystem()
  const venv = createVenvManager({
    config: {
      dshHome,
      engineVersion,
      pythonVersion: '3.13',
      requirementsFile: join(process.cwd(), 'python-assets', 'requirements.lock'),
      indexUrl: 'https://example.invalid/simple',
    },
    runner: options.runner,
    fs,
    env: {},
  })
  const engine = createMasterEngine({
    workspace,
    venv,
    ...(options.log === true ? { log: createWorkspaceLogSink({ workspace, fs }) } : {}),
  })
  return { engine, fs, venv }
}

const codeOf = (run: () => unknown): string => {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}

describe('master engine path handling', () => {
  it('converts paths to workspace-relative form and runs from the workspace', () => {
    const runner = createFakeRunner((call) => {
      if (call.args[0] === 'svg-to-pptx') {
        ;(call.options.env as Record<string, string>).PYTHONIOENCODING = 'utf-8'
        return ok(`wrote ${join(workspace, 'out', 'deep.pptx')}`)
      }
      return ok()
    })
    const { engine, fs } = buildEngine({ runner })
    fs.writeText(join(workspace, 'out', 'deep.pptx'), 'PK')
    fs.writeText(join(workspace, 'deep', 'project', 'validation', 'deep.report.json'), '{}')
    engine.renderDeep({ projectDir: join(workspace, 'deep', 'project'), outputFile: join(workspace, 'out', 'deep.pptx') })
    const call = runner.calls[0]
    expect(call?.command).toBe(paths.engineExe)
    expect(call?.options.cwd).toBe(workspace)
    expect(call?.args).toContain('deep/project')
    expect(call?.args.some((argument) => argument.includes('out/deep.pptx'))).toBe(true)
    expect(call?.options.env.PYTHONIOENCODING).toBe('utf-8')
    expect(call?.options.env.PYTHONNOUSERSITE).toBe('1')
  })

  it('refuses a project directory outside the workspace before starting a process', () => {
    const runner = createFakeRunner()
    const { engine } = buildEngine({ runner })
    const code = codeOf(() => engine.renderDeep({ projectDir: join(workspace, '..', 'elsewhere'), outputFile: 'out/x.pptx' }))
    expect(code).toBe('PathOutsideWorkspace')
    expect(runner.calls).toHaveLength(0)
  })
})

describe('master engine failure classification', () => {
  it('reports a missing contracted output', () => {
    const runner = createFakeRunner(() => ok('all good'))
    const { engine } = buildEngine({ runner })
    const code = codeOf(() => engine.renderDeep({ projectDir: 'deep/project', outputFile: 'out/deep.pptx' }))
    expect(code).toBe('OutputMissing')
  })

  it('reports a non-zero exit with the stderr tail', () => {
    const runner = createFakeRunner(() => fail(1, 'traceback\nValueError: chart payload is not bound'))
    const { engine } = buildEngine({ runner })
    try {
      engine.renderDeep({ projectDir: 'deep/project', outputFile: 'out/deep.pptx' })
      expect.unreachable('expected a failure')
    } catch (error) {
      expect((error as DshPptFailure).code).toBe('EngineExit')
      expect((error as DshPptFailure).message).toContain('chart payload is not bound')
    }
  })

  it('reports a timeout separately from an exit code', () => {
    const runner = createFakeRunner(() => timedOut('partial'))
    const { engine } = buildEngine({ runner })
    expect(codeOf(() => engine.qualityCheck({ target: 'deep/project', stage: 'final' }))).toBe('EngineTimeout')
  })

  it('reports a missing venv before spawning anything', () => {
    const runner = createFakeRunner()
    const emptyFs = createFakeFileSystem({ files: {} })
    const { engine } = buildEngine({ runner, fs: emptyFs })
    expect(codeOf(() => engine.deliveryCheck({ file: 'out/deep.pptx' }))).toBe('VenvMissing')
    expect(runner.calls).toHaveLength(0)
  })

  it('writes a diagnostics log when a run fails', () => {
    const runner = createFakeRunner(() => fail(2, 'boom'))
    const { engine, fs } = buildEngine({ runner, log: true })
    expect(codeOf(() => engine.qualityCheck({ target: 'deep/project', stage: 'final' }))).toBe('EngineExit')
    const logs = fs.listDir(join(workspace, '.dsh-ppt', 'logs'))
    expect(logs).toHaveLength(1)
    const body = fs.readText(join(workspace, '.dsh-ppt', 'logs', logs[0] ?? '')) ?? ''
    expect(body).toContain('command: svg-quality-check')
    expect(body).toContain('outcome: EngineExit')
    expect(body).toContain('boom')
  })
})

describe('master engine project init', () => {
  it('returns the created project directory and keeps it inside the workspace', () => {
    const created = join(workspace, 'deep', 'hello_ppt169_20260922')
    const runner = createFakeRunner(() => ok(`Project created: ${created}\nCanvas: PPT 16:9\n`))
    const { engine } = buildEngine({ runner })
    const call = engine.projectInit({ name: 'hello', baseDir: 'deep', format: 'ppt169' })
    expect(call.projectDir).toBe(created)
  })

  it('fails loudly when the receipt lacks the created directory', () => {
    const runner = createFakeRunner(() => ok('nothing useful'))
    const { engine } = buildEngine({ runner })
    expect(codeOf(() => engine.projectInit({ name: 'hello', baseDir: 'deep', format: 'ppt169' }))).toBe('OutputMissing')
  })
})
