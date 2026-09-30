// Single source for the DSH runtime lines this plugin supports (ADR-079, V11 A3).
//
// npm and pnpm admit a prerelease version only when a comparator on the same
// major.minor.patch tuple carries its own prerelease tag, so the peer range needs one band per
// patch line the plugin is willing to meet (the runtime gate is looser: it evaluates with
// includePrerelease). `COVERED_PATCH_LINES` is that list; `RUNTIME_LINES` records the lines a
// compatibility probe actually measured and must be a subset of it. The union is derived from
// both, `scripts/gen-peer-union.mjs` writes it into package.json, and `--check` fails when the
// manifest drifts, so adding a line is a one-file edit plus a re-run.

/**
 * DSH runtime lines measured by `scripts/dsh-compat.mjs` / `dsh-compat-profile.mjs`
 * (exact versions, ascending; the newest line ends the union).
 */
export const RUNTIME_LINES = ['0.1.2-rc.1', '0.1.7-rc.2', '0.2.0-rc.2']

/**
 * Patch lines the union enumerates as install bands, ascending. It runs from the oldest measured
 * tuple to the newest; the patches between the measured lines are the published 0.1.x releases a
 * user may still be on, and the last entry opens the band that admits later patches of its minor.
 */
export const COVERED_PATCH_LINES = ['0.1.2', '0.1.3', '0.1.4', '0.1.5', '0.1.6', '0.1.7', '0.1.8', '0.2.0']

/** DSH packages whose peer ranges the runtime compatibility gate evaluates. */
export const DSH_PEERS = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-client-ui-tool', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-tools']

/** @param version - a semver, with or without a prerelease tag. @returns its `major.minor.patch` tuple. */
export function tupleOf(version) {
  const [major, minor, patch] = version.split('-')[0].split('.').map((part) => Number.parseInt(part, 10))
  if (![major, minor, patch].every((part) => Number.isInteger(part))) throw new Error(`${version} is not a semver`)
  return `${String(major)}.${String(minor)}.${String(patch)}`
}

/** @param version - a semver. @returns its `major.minor` minor line. */
export function minorOf(version) {
  const [major, minor] = tupleOf(version).split('.').map((part) => Number.parseInt(part, 10))
  return `${String(major)}.${String(minor)}`
}

/** @param version - a `major.minor` minor line. @returns the next minor line. */
export function nextMinor(minor) {
  const [major, index] = minor.split('.').map((part) => Number.parseInt(part, 10))
  return index >= 99 ? `${String(major + 1)}.0` : `${String(major)}.${String(index + 1)}`
}

/**
 * @param lines - patch lines, ascending.
 * @returns one band per line: it admits that line's prereleases and everything above it inside
 *   the same minor, and the newest band stops before the next minor's first release.
 */
export function bandsFor(lines = COVERED_PATCH_LINES) {
  return lines.map((line, index) => {
    const last = index === lines.length - 1
    const next = last ? COVERED_PATCH_LINES[COVERED_PATCH_LINES.length - 1] : lines[index + 1]
    if (last) return `>=${line}-rc.1 <${nextMinor(minorOf(line))}.0-0`
    if (minorOf(next) === minorOf(line)) return `>=${line}-rc.1 <${next}`
    return `>=${line} <${next}-0`
  })
}

/**
 * @param lines - patch lines, ascending.
 * @returns the peer range every `@deepseek-ai/dsh*` peer carries.
 */
export function dshPeerRange(lines = COVERED_PATCH_LINES) {
  return bandsFor(lines).join(' || ')
}

/**
 * @param lines - patch lines, ascending.
 * @returns lines the union deliberately refuses: the minor right after the newest covered one and
 *   a far-future major, so an unmeasured line cannot install by accident.
 */
export function unsupportedLines(lines = COVERED_PATCH_LINES) {
  const newest = lines[lines.length - 1]
  return [`${nextMinor(minorOf(newest))}.0-rc.1`, '1.0.0']
}

/** @returns problems with the two declared lists, empty when they are consistent. */
export function governanceProblems(runtimeLines = RUNTIME_LINES, coveredLines = COVERED_PATCH_LINES) {
  const problems = []
  if (runtimeLines.length === 0) problems.push('RUNTIME_LINES is empty')
  if (coveredLines.length === 0) problems.push('COVERED_PATCH_LINES is empty')
  const covered = new Set(coveredLines.map((line) => tupleOf(line)))
  for (const line of runtimeLines) {
    if (!covered.has(tupleOf(line))) problems.push(`measured line ${line} is not covered by COVERED_PATCH_LINES`)
  }
  const ascending = [...coveredLines].sort((left, right) => {
    const [leftMajor, leftMinor, leftPatch] = tupleOf(left).split('.').map(Number)
    const [rightMajor, rightMinor, rightPatch] = tupleOf(right).split('.').map(Number)
    return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch
  })
  if (ascending.join('|') !== coveredLines.map((line) => tupleOf(line)).join('|')) problems.push('COVERED_PATCH_LINES is not ascending')
  const newestMeasured = [...runtimeLines].sort().at(-1)
  if (newestMeasured !== undefined && tupleOf(newestMeasured) !== tupleOf(coveredLines[coveredLines.length - 1])) {
    problems.push(`the newest measured line ${newestMeasured} does not end the union (${String(coveredLines[coveredLines.length - 1])})`)
  }
  return problems
}