import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Absolute path of this package's root directory.
 *
 * The same relative location works for the source entry (`src/*.ts`) and for the
 * bundle (`dist/cli.js`), so asset lookups do not depend on the process's working
 * directory — which matters once this runs as an installed DSH plugin rather than
 * from a checkout.
 *
 * @returns the package root.
 */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Locate a file that ships with the package.
 *
 * @param relativePath - path relative to the package root.
 * @param fallbackCwd - working directory to try second, for source launches that
 *   run from a different checkout layout.
 * @returns the first existing candidate, or the package-relative path when none
 *   exists (the caller reports it as missing with the path it expected).
 */
export function packageAsset(relativePath: string, fallbackCwd = process.cwd()): string {
  const fromPackage = join(packageRoot(), relativePath)
  if (existsSync(fromPackage)) return fromPackage
  const fromCwd = join(fallbackCwd, relativePath)
  if (existsSync(fromCwd)) return fromCwd
  return fromPackage
}
