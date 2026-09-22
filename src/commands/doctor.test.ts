import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { runDoctor, PINNED } from './doctor.ts'
import { venvPaths } from '../engine/venv.ts'
import { createFakeFileSystem, createFakeRunner, fail, ok, type FakeCall, type FakeFileSystem } from '../../tests/support/fake-runner.ts'

const cwd = join(process.cwd(), 'tmp')
const dshHome = join(cwd, 'dsh-home')
const engineVersion = PINNED.pptMaster
const paths = venvPaths(dshHome, engineVersion, '3.13', 'win32')
const probePath = join(process.cwd(), 'python-assets', 'probe-png-renderer.py')

/** A filesystem holding a usable engine venv. */
function healthyFs(): FakeFileSystem {
  return createFakeFileSystem({
    files: {
      [paths.pythonExe]: 'binary',
      [paths.engineExe]: 'binary',
      [join(paths.sitePackages, `ppt_master-${engineVersion}.dist-info`, 'METADATA')]: 'Name: ppt-master\n',
      [probePath]: '# probe\n',
    },
    directories: [paths.root],
  })
}

/** Answers the probes `doctor` runs, with the renderer payload under test. */
function doctorRunner(rendererProbe: unknown, probeOverrides: { probeStatus?: number; probeStdout?: string } = {}) {
  return createFakeRunner((call: FakeCall) => {
    if (call.command === 'where.exe') return ok(join(cwd, 'tools', 'uv.exe'))
    if (call.args[0] === '--version' && call.command.startsWith('python')) return ok('Python 3.13.12\n')
    if (call.command === paths.engineExe && call.args[0] === '--help') return ok('Usage: ppt-master <command> [args...]\n\nCommands:\n  project  Manage projects\n  svg-to-pptx  Export\n')
    if (call.args[0] === probePath) {
      if (probeOverrides.probeStdout !== undefined) return { status: probeOverrides.probeStatus ?? 0, stdout: probeOverrides.probeStdout, stderr: '' }
      return { status: probeOverrides.probeStatus ?? 0, stdout: JSON.stringify(rendererProbe), stderr: '' }
    }
    if (call.command === 'powershell') return ok('ok 16.0\n')
    return ok('')
  })
}

const doctor = (rendererProbe: unknown, options: { probeStdout?: string; probeStatus?: number } = {}) =>
  runDoctor({
    dshHome,
    engineVersion,
    requirementsFile: join(process.cwd(), 'python-assets', 'requirements.lock'),
    workspace: join(dshHome, 'ppt-fusion', 'doctor'),
    dependencies: {
      runner: doctorRunner(rendererProbe, options),
      fs: healthyFs(),
      env: { LOCALAPPDATA: join(cwd, 'LocalAppData') },
      platform: 'win32',
      resolveModule: () => 'file:///nowhere',
      selfTest: false,
    },
  })

describe('doctor checks', () => {
  it('reports the eight checks plus a skipped self-test', () => {
    const report = doctor({ renderer: 'cairosvg', status: '(full gradient/filter support)', hint: null, converted: true, pngBytes: 1234 })
    expect(report.checks.map((check) => check.id)).toEqual([
      'node',
      'uv',
      'python',
      'venv',
      'ppt-master',
      'png-renderer',
      'pptwise',
      'powerpoint-com',
    ])
    expect(report.selfTest.ok).toBe(true)
    expect(report.checks.find((c) => c.id === 'png-renderer')?.status).toBe('ok')
  })
})

describe('the PNG rasteriser check', () => {
  it('passes when a renderer imports and actually writes a PNG', () => {
    const report = doctor({ renderer: 'cairosvg', status: '(full gradient/filter support)', hint: null, converted: true, pngBytes: 2048 })
    const check = report.checks.find((entry) => entry.id === 'png-renderer')
    expect(check?.status).toBe('ok')
    expect(check?.detail).toContain('cairosvg')
    expect(check?.detail).toContain('2048-byte PNG')
  })

  it('fails with the engine install hint when nothing imports, which is this machine', () => {
    const report = doctor({
      renderer: null,
      status: '(not installed)',
      hint: 'Install via: pip install cairosvg or pip install svglib reportlab',
      converted: false,
      pngBytes: 0,
      installed: { cairosvg: '2.9.1', cairocffi: '1.7.1', pycairo: null, svglib: null, reportlab: null },
      importError: 'no library called "cairo-2" was found',
    })
    const check = report.checks.find((entry) => entry.id === 'png-renderer')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('cairosvg 2.9.1 is installed but cannot import')
    expect(check?.detail).toContain('cairo-2')
    expect(check?.fix).toContain('cairo runtime')
  })

  it('fails when a renderer imports but cannot render, which is the silent-degradation trap', () => {
    const report = doctor({
      renderer: 'svglib',
      status: '(some gradients may be lost)',
      hint: 'Install cairosvg for better results: pip install cairosvg',
      converted: false,
      pngBytes: 0,
      error: 'cannot import desired renderPM backend rlPyCairo',
    })
    const check = report.checks.find((entry) => entry.id === 'png-renderer')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('produced no PNG')
    expect(check?.detail).toContain('rlPyCairo')
  })

  it('reports a plain absence when nothing is installed', () => {
    const report = doctor({ renderer: null, status: '(not installed)', hint: null, converted: false, pngBytes: 0, installed: { cairosvg: null } })
    expect(report.checks.find((entry) => entry.id === 'png-renderer')?.detail).toContain('no SVG-to-PNG renderer imports')
  })

  it('fails when the probe cannot run at all', () => {
    const report = doctor({}, { probeStatus: 1, probeStdout: '' })
    const check = report.checks.find((entry) => entry.id === 'png-renderer')
    expect(check?.status).toBe('fail')
    expect(check?.detail).toContain('produced no JSON')
  })

  it('fails without spawning when the venv is unusable', () => {
    const report = runDoctor({
      dshHome,
      engineVersion,
      dependencies: {
        runner: createFakeRunner(() => fail(1)),
        fs: createFakeFileSystem({}),
        env: {},
        platform: 'win32',
        resolveModule: () => 'file:///nowhere',
        selfTest: false,
      },
    })
    expect(report.checks.find((entry) => entry.id === 'png-renderer')?.status).toBe('fail')
    expect(report.checks.find((entry) => entry.id === 'png-renderer')?.detail).toContain('venv is unusable')
  })
})
