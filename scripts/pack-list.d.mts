/** One file entry of npm's `pack --dry-run --json` payload. */
export interface PackEntry {
  readonly path: string
  readonly size?: number
}

/** One packed package in npm's `pack --dry-run --json` payload. */
export interface PackResult {
  readonly files?: readonly PackEntry[]
}

/**
 * @param stdout - raw stdout of `npm pack --dry-run --json`, which may carry the
 *   `prepare` script's coloured build log before the payload.
 * @returns the parsed payload array, or undefined when no JSON array is present.
 */
export declare function packList(stdout: string): PackResult[] | undefined
