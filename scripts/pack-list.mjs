// npm's `pack --dry-run --json` file list, parsed defensively.
//
// npm 11 with `--ignore-scripts` prints the JSON payload alone. npm 10 prints the
// `prepare` script's output first (its `pack` still runs lifecycle scripts) and a
// trailing "." after the payload, so the caller cannot hand the raw stdout to
// JSON.parse.

/**
 * @param stdout - raw stdout of `npm pack --dry-run --json`.
 * @returns the parsed payload array, or undefined when no JSON array is present.
 */
export function packList(stdout) {
  const start = stdout.indexOf('[')
  if (start < 0) return undefined
  const end = stdout.lastIndexOf(']')
  if (end < start) return undefined
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
