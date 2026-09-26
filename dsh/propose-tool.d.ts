/** Tool name the harness registers. */
export declare const PROPOSE_TOOL_NAME: 'dsh_ppt_propose'
/** Route prefix the card fetches from. */
export declare const PROPOSE_ROUTE: string
/** Header every answer from this route carries. */
export declare const PROPOSE_ROUTE_HEADER: string
/** Value of {@link PROPOSE_ROUTE_HEADER}. */
export declare const PROPOSE_ROUTE_HEADER_VALUE: string
/** Schema version of a card payload. */
export declare const PROPOSE_PAYLOAD_SCHEMA_VERSION: 1
/** Page thumbnails one card may attach. */
export declare const PROPOSE_CARD_PAGES: number
/** Findings one card payload carries per list. */
export declare const PROPOSE_CARD_FINDINGS: number
/** @param value - candidate proposal id. @returns true when it is safe as a file name. */
export declare function isProposalId(value: unknown): boolean
/** One card payload page entry. */
export interface ProposeCardPage {
  readonly index: number
  readonly engine: string
  readonly path: string
  readonly url: string
}
/** The tool plus its route registrar. */
export interface ProposeService {
  readonly tool: {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
    readonly output: {
      readonly schema: Record<string, unknown>
      render(args: Record<string, unknown>, value: Record<string, unknown>): unknown[]
      presentationMeta(args: Record<string, unknown>, value: Record<string, unknown>): Record<string, unknown>
    }
    readonly timeoutMs: number
    execute(args: Record<string, unknown>, exec: Record<string, unknown>): Promise<Record<string, unknown>>
    presentCall(args: Record<string, unknown>): Record<string, unknown>
  }
  registerRoute(ctx: unknown): void
  summarizeDiff(diff: unknown): Record<string, unknown>
  isProposalId(value: unknown): boolean
}
/**
 * Build the propose service for one plugin instance.
 *
 * @param cliPath - absolute path of the packaged CLI.
 * @param options.home - plugin home for card payloads.
 * @param options.resolveNode - Node executable used for CLI children.
 * @param options.runCli - CLI runner override for tests.
 */
export declare function createProposeService(cliPath: string, options?: { home?: string; resolveNode?: () => string; runCli?: (args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }> }): ProposeService