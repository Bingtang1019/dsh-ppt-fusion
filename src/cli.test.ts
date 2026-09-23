import { beforeAll, describe, expect, it } from 'vitest'
import type { Command } from 'commander'
import { defaultDependencies } from './commands/context.ts'
import { createFakeFileSystem, createFakeRunner } from '../tests/support/fake-runner.ts'

/** One leaf command in the built program. */
interface Leaf {
  readonly path: string
  readonly longOptions: readonly string[]
  readonly description: string
}

/** @returns every leaf command, parents before children. */
function leaves(command: Command, prefix: string[] = []): Leaf[] {
  const here = [...prefix, command.name()]
  const children = command.commands
  if (children.length === 0) {
    return [{ path: here.join(' '), longOptions: command.options.flatMap((option) => (option.long === undefined ? [] : [option.long])), description: command.description() }]
  }
  return children.flatMap((child) => leaves(child, here))
}

/** @returns the program with the CLI argv hook disabled. */
async function loadProgram(): Promise<Command> {
  process.env.DSH_PPT_NO_RUN = '1'
  const { buildProgram } = await import('./cli.ts')
  return buildProgram(defaultDependencies({ fs: createFakeFileSystem(), runner: createFakeRunner() }))
}

describe('CLI surface', () => {
  // The CLI module graph is the heaviest import in the suite; under parallel
  // workers a single import can pass 5s. Load it once with a generous hook
  // timeout, so the assertions below never race the module graph (ADR-063).
  let program: Command
  beforeAll(async () => {
    program = await loadProgram()
  }, 30_000)

  it('offers --json on every leaf command except version', () => {
    const missing = leaves(program)
      .filter((leaf) => leaf.path !== 'dsh-ppt version')
      .filter((leaf) => !leaf.longOptions.includes('--json'))
      .map((leaf) => leaf.path)
    expect(missing).toEqual([])
  })

  it('keeps every leaf described and free of duplicate options', () => {
    for (const leaf of leaves(program)) {
      expect(leaf.description, leaf.path).not.toBe('')
      const duplicates = leaf.longOptions.filter((option, index) => leaf.longOptions.indexOf(option) !== index)
      expect(duplicates, leaf.path).toEqual([])
    }
  })

  it('covers the documented command groups', () => {
    const paths = leaves(program).map((leaf) => leaf.path)
    for (const expected of [
      'dsh-ppt version',
      'dsh-ppt doctor',
      'dsh-ppt init',
      'dsh-ppt plan',
      'dsh-ppt resume',
      'dsh-ppt validate',
      'dsh-ppt audit',
      'dsh-ppt preview',
      'dsh-ppt render',
      'dsh-ppt skill audit',
      'dsh-ppt theme ensure',
      'dsh-ppt deep render',
      'dsh-ppt deep template create',
      'dsh-ppt deep template apply',
      'dsh-ppt deep template register',
      'dsh-ppt deep native roundtrip',
      'dsh-ppt compat lint',
      'dsh-ppt images search',
      'dsh-ppt post animate',
      'dsh-ppt narrate',
      'dsh-ppt brand extract',
      'dsh-ppt tokens export',
      'dsh-ppt source',
    ]) {
      expect(paths, expected).toContain(expected)
    }
  })
})
