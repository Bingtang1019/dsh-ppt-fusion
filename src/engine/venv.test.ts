import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { createVenvManager, resolveUv, venvPaths } from './venv.ts'
import { DshPptFailure } from './errors.ts'
import { createFakeFileSystem, createFakeRunner, fail, ok, type FakeFileSystem } from '../../tests/support/fake-runner.ts'

const dshHome = join(process.cwd(), 'tmp', 'dsh-home')
const engineVersion = '0.1.128'
const paths = venvPaths(dshHome, engineVersion, '3.13', 'win32')
const lockFile = join(process.cwd(), 'python-assets', 'requirements.lock')
const storeRoot = join(process.cwd(), 'tmp', 'LocalAppData', 'Packages')
const storeScripts = join(storeRoot, 'PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0', 'LocalCache', 'local-packages', 'Python313', 'Scripts')
const storeUv = join(storeScripts, 'uv.exe')

const codeOf = (run: () => unknown): string => {
  try {
    run()
    return 'no-failure'
  } catch (error) {
    return error instanceof DshPptFailure ? error.code : 'not-a-DshPptFailure'
  }
}

describe('resolveUv', () => {
  it('prefers an explicit DSH_PPT_UV override', () => {
    const fs = createFakeFileSystem({ files: { [storeUv]: 'binary', 'C:/tools/uv.exe': 'binary' } })
    const resolution = resolveUv({
      runner: createFakeRunner(),
      fs,
      env: { DSH_PPT_UV: 'C:/tools/uv.exe' },
      platform: 'win32',
    })
    expect(resolution.source).toBe('DSH_PPT_UV')
    expect(resolution.baseArgs).toEqual([])
  })

  it('finds the Windows Store shim under local-packages', () => {
    const fs = createFakeFileSystem({ files: { [storeUv]: 'binary' } })
    const resolution = resolveUv({
      runner: createFakeRunner(),
      fs,
      env: {},
      localAppData: join(process.cwd(), 'tmp', 'LocalAppData'),
      platform: 'win32',
    })
    expect(resolution.command).toBe(storeUv)
    expect(resolution.source).toBe('local-packages')
  })

  it('falls back to PATH and then to python -m uv', () => {
    const emptyFs = createFakeFileSystem({})
    const fromPath = resolveUv({
      runner: createFakeRunner(() => ok('C:\\tools\\uv.exe\n')),
      fs: emptyFs,
      env: { PATH: 'C:\\tools' },
      platform: 'win32',
    })
    expect(fromPath.source).toBe('path')
    expect(fromPath.command).toBe('C:\\tools\\uv.exe')

    const viaModule = resolveUv({
      runner: createFakeRunner((call) => (call.command === 'where.exe' ? fail(1) : ok('uv 0.12.17\n'))),
      fs: emptyFs,
      env: {},
      platform: 'win32',
    })
    expect(viaModule.source).toBe('python-module')
    expect(viaModule.command).toBe('python')
    expect(viaModule.baseArgs).toEqual(['-m', 'uv'])
  })

  it('reports UvMissing with the searched locations', () => {
    const resolution = () =>
      resolveUv({
        runner: createFakeRunner(() => fail(1)),
        fs: createFakeFileSystem({}),
        env: {},
        platform: 'win32',
      })
    expect(codeOf(resolution)).toBe('UvMissing')
  })
})

describe('venv layout across platforms', () => {
  it('uses Scripts and Lib\\site-packages on Windows', () => {
    const win = venvPaths('C:/home/.dsh', '0.1.128', '3.13', 'win32')
    expect(win.pythonExe.endsWith(join('Scripts', 'python.exe'))).toBe(true)
    expect(win.sitePackages.endsWith(join('Lib', 'site-packages'))).toBe(true)
  })

  it('uses bin and lib/pythonX.Y/site-packages elsewhere, which is what the ubuntu CI leg sees', () => {
    const posix = venvPaths('/home/me/.dsh', '0.1.128', '3.13', 'linux')
    expect(posix.pythonExe).toBe('/home/me/.dsh/ppt-fusion/venvs/ppt-master-0.1.128/bin/python')
    expect(posix.engineExe).toBe('/home/me/.dsh/ppt-fusion/venvs/ppt-master-0.1.128/bin/ppt-master')
    expect(posix.sitePackages).toBe('/home/me/.dsh/ppt-fusion/venvs/ppt-master-0.1.128/lib/python3.13/site-packages')
  })
})

describe('venv state', () => {
  const managerWith = (fs: FakeFileSystem) =>
    createVenvManager({
      config: { dshHome, engineVersion, pythonVersion: '3.13', requirementsFile: lockFile, indexUrl: 'https://example.invalid/simple' },
      runner: createFakeRunner(),
      fs,
      env: {},
    })

  it('is ok when the interpreter, engine and pinned distribution are present', () => {
    const state = managerWith(
      createFakeFileSystem({
        files: {
          [paths.pythonExe]: 'binary',
          [paths.engineExe]: 'binary',
          [join(paths.sitePackages, 'ppt_master-0.1.128.dist-info', 'METADATA')]: 'Name: ppt-master',
        },
        directories: [paths.root],
      }),
    ).state()
    expect(state.ok).toBe(true)
    expect(state.installedVersion).toBe('0.1.128')
  })

  it('names every missing piece', () => {
    const state = managerWith(createFakeFileSystem({})).state()
    expect(state.ok).toBe(false)
    expect(state.problems.join(' ')).toContain('venv directory is absent')
  })

  it('flags a version mismatch rather than silently accepting it', () => {
    const state = managerWith(
      createFakeFileSystem({
        files: {
          [paths.pythonExe]: 'binary',
          [paths.engineExe]: 'binary',
          [join(paths.sitePackages, 'ppt_master-0.1.127.dist-info', 'METADATA')]: 'Name: ppt-master',
        },
        directories: [paths.root],
      }),
    ).state()
    expect(state.ok).toBe(false)
    expect(state.problems.join(' ')).toContain('installed engine is 0.1.127')
  })
})

describe('venv install and repair', () => {
  it('creates the venv with uv and installs the lock file', () => {
    const fs = createFakeFileSystem({ files: { [lockFile]: 'ppt-master==0.1.128\n', 'C:/tools/uv.exe': 'binary' } })
    const runner = createFakeRunner((call) => {
      if (call.args[0] === 'venv') {
        fs.writeText(paths.pythonExe, 'binary')
        fs.writeText(paths.engineExe, 'binary')
        return ok('Creating virtual environment\n')
      }
      if (call.args[0] === 'pip') {
        fs.writeText(join(paths.sitePackages, 'ppt_master-0.1.128.dist-info', 'METADATA'), 'Name: ppt-master')
        return ok('Installed 42 packages\n')
      }
      return ok()
    })
    const manager = createVenvManager({
      config: { dshHome, engineVersion, pythonVersion: '3.13', requirementsFile: lockFile, indexUrl: 'https://example.invalid/simple' },
      runner,
      fs,
      env: { DSH_PPT_UV: 'C:/tools/uv.exe' },
    })
    const state = manager.ensure()
    expect(state.ok).toBe(true)
    const kinds = runner.calls.map((call) => call.args[0])
    expect(kinds).toEqual(['venv', 'pip'])
    expect(runner.calls[1]?.args).toContain('--index-url')
    expect(runner.calls[1]?.args).toContain(lockFile)
  })

  it('starts no process when the venv is already correct', () => {
    const fs = createFakeFileSystem({
      files: {
        [paths.pythonExe]: 'binary',
        [paths.engineExe]: 'binary',
        [join(paths.sitePackages, 'ppt_master-0.1.128.dist-info', 'METADATA')]: 'Name: ppt-master',
        [lockFile]: 'ppt-master==0.1.128\n',
      },
      directories: [paths.root],
    })
    const runner = createFakeRunner()
    const manager = createVenvManager({
      config: { dshHome, engineVersion, pythonVersion: '3.13', requirementsFile: lockFile, indexUrl: 'https://example.invalid/simple' },
      runner,
      fs,
      env: {},
    })
    expect(manager.ensure().ok).toBe(true)
    expect(runner.calls).toHaveLength(0)
  })

  it('refuses to install when the locked requirements file is absent', () => {
    const manager = createVenvManager({
      config: { dshHome, engineVersion, pythonVersion: '3.13', requirementsFile: lockFile, indexUrl: 'https://example.invalid/simple' },
      runner: createFakeRunner(),
      fs: createFakeFileSystem({ files: { 'C:/tools/uv.exe': 'binary' } }),
      env: { DSH_PPT_UV: 'C:/tools/uv.exe' },
    })
    expect(codeOf(() => manager.ensure())).toBe('OutputMissing')
  })

  it('reports a venv install failure as an engine exit', () => {
    const fs = createFakeFileSystem({ files: { [lockFile]: 'ppt-master==0.1.128\n', 'C:/tools/uv.exe': 'binary' } })
    const runner = createFakeRunner((call) => (call.args[0] === 'pip' ? fail(1, 'No matching distribution') : ok('')))
    const manager = createVenvManager({
      config: { dshHome, engineVersion, pythonVersion: '3.13', requirementsFile: lockFile, indexUrl: 'https://example.invalid/simple' },
      runner,
      fs,
      env: { DSH_PPT_UV: 'C:/tools/uv.exe' },
    })
    expect(codeOf(() => manager.ensure())).toBe('EngineExit')
  })
})
