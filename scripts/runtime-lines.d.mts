// Types for scripts/runtime-lines.mjs (ADR-090). The module is plain ESM because the release path
// (`pnpm prepack`) runs it and the generator without a TypeScript loader; this declaration is what the
// vitest suite sees.

/** DSH runtime lines measured by the compatibility probe, ascending. */
export declare const RUNTIME_LINES: readonly string[]
/** Patch lines the peer union enumerates as install bands, ascending. */
export declare const COVERED_PATCH_LINES: readonly string[]
/** DSH packages whose peer ranges the runtime compatibility gate evaluates. */
export declare const DSH_PEERS: readonly string[]
/** @param version - a semver, with or without a prerelease tag. @returns its `major.minor.patch` tuple. */
export declare function tupleOf(version: string): string
/** @param version - a semver. @returns its `major.minor` minor line. */
export declare function minorOf(version: string): string
/** @param minor - a `major.minor` minor line. @returns the next minor line. */
export declare function nextMinor(minor: string): string
/** @param lines - patch lines, ascending. @returns one install band per line. */
export declare function bandsFor(lines?: readonly string[]): string[]
/** @param lines - patch lines, ascending. @returns the peer range every `@deepseek-ai/dsh*` peer carries. */
export declare function dshPeerRange(lines?: readonly string[]): string
/** @param lines - patch lines, ascending. @returns lines the union deliberately refuses. */
export declare function unsupportedLines(lines?: readonly string[]): string[]
/** @returns problems with the two declared lists, empty when they are consistent. */
export declare function governanceProblems(runtimeLines?: readonly string[], coveredLines?: readonly string[]): string[]