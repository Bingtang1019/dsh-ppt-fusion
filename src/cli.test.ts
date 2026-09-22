import { describe, expect, it } from 'vitest'
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
  it('offers --json on every leaf command except version', async () => {
    const program = await loadProgram()
    const missing = leaves(program)
      .filter((leaf) => leaf.path !== 'dsh-ppt version')
      .filter((leaf) => !leaf.longOptions.includes('--json'))
      .map((leaf) => leaf.path)
    expect(missing).toEqual([])
  })

  it('keeps every leaf described and free of duplicate options', async () => {
    const program = await loadProgram()
    for (const leaf of leaves(program)) {
      expect(leaf.description, leaf.path).not.toBe('')
      const duplicates = leaf.longOptions.filter((option, index) => leaf.longOptions.indexOf(option) !== index)
      expect(duplicates, leaf.path).toEqual([])
    }
  })

  it('covers the documented command groups', async () => {
    const program = await loadProgram()
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
