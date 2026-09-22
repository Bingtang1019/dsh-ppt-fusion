import { join } from 'node:path'
import { venvPaths, type VenvPaths } from '../../src/engine/venv.ts'
import { PINNED } from '../../src/commands/doctor.ts'
import type { FakeFileSystem } from './fake-runner.ts'

/**
 * Install the venv files the engine manager checks before it spawns, so a command
 * test can reach the spawn (answered by a fake runner) without a real engine.
 *
 * @param fs - in-memory filesystem.
 * @param options.dshHome - `$DSH_HOME` the manager resolves.
 * @returns the paths that were created.
 */
export function installFakeVenv(fs: FakeFileSystem, options: { dshHome: string }): VenvPaths {
  const paths = venvPaths(options.dshHome, PINNED.pptMaster, PINNED.python)
  fs.writeText(paths.pythonExe, 'fake interpreter\n')
  fs.writeText(paths.engineExe, 'fake dispatcher\n')
  fs.writeText(join(paths.sitePackages, `ppt_master-${PINNED.pptMaster}.dist-info`, 'METADATA'), 'Name: ppt-master\n')
  return paths
}
