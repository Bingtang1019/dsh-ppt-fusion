/** Tool name the harness registers. */
export declare const REVIEW_TOOL_NAME: 'dsh_ppt_review'
/** Deck-relative directory the review record lives in. */
export declare const REVIEW_DIR: string
/** Deck-relative review record path. */
export declare const REVIEW_FILE: string
/** Schema version of the review record. */
export declare const REVIEW_SCHEMA_VERSION: 1
/** Page images one inspection may attach unless the caller narrows it further. */
export declare const REVIEW_MAX_PAGES: number
/** The rubric the model applies to every attached page. */
export declare const REVIEW_RUBRIC: string
/** One recorded finding. */
export interface ReviewFinding {
  readonly page: number
  readonly severity: 'error' | 'warning' | 'info'
  readonly rule: string
  readonly message: string
  readonly fix?: string
}
/** The tool the plugin registers. */
export interface ReviewTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: { readonly schema: Record<string, unknown>; render: (args: Record<string, unknown>, value: Record<string, unknown>) => unknown[] }
  readonly timeoutMs: number
  execute(args: Record<string, unknown>, exec: Record<string, unknown>): Promise<Record<string, unknown>>
  presentCall(args: Record<string, unknown>): Record<string, unknown>
}
/**
 * Build the review service for one plugin instance.
 *
 * @param cliPath - absolute path of the packaged CLI.
 * @param options.ctx - the plugin scope carrying `attachments` and `llm`.
 * @param options.resolveNode - Node executable used for the CLI child.
 * @returns the tool plus its pure helpers.
 */
export declare function createReviewService(cliPath: string, options?: { ctx?: unknown; resolveNode?: () => string }): {
  tool: ReviewTool
  REVIEW_RUBRIC: string
  normalizeFindings: (findings: unknown, pageCount: number) => ReviewFinding[]
}