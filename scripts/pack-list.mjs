// npm's `pack --dry-run --json` file list, parsed defensively.
//
// npm 11 with `--ignore-scripts` prints the JSON payload alone. npm 10 prints the
// `prepare` script's coloured build log first (its `pack` still runs lifecycle
// scripts) and a trailing "." after the payload, so the caller cannot hand the raw
// stdout to JSON.parse; the build log also contains ANSI escapes and brackets of
// its own, so the payload is located by its own line-anchored delimiters.

/** ANSI colour escapes in npm/tsup output. */
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g

/**
 * @param stdout - raw stdout of `npm pack --dry-run --json`.
 * @returns the parsed payload array, or undefined when no JSON array is present.
 */
export function packList(stdout) {
  const clean = stdout.replace(ANSI, '')
  const start = clean.search(/^\[/m)
  if (start < 0) return undefined
  const end = clean.lastIndexOf(']')
  if (end < start) return undefined
  try {
    const parsed = JSON.parse(clean.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
