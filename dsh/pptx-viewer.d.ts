/** Route prefix the client preview fetches from. */
export declare const PPTX_VIEWER_ROUTE: string
/** Header every answer from this route carries. */
export declare const PPTX_VIEWER_HEADER: string
/** Value of {@link PPTX_VIEWER_HEADER}. */
export declare const PPTX_VIEWER_HEADER_VALUE: string
/** Deck suffixes this viewer claims. */
export declare const PPTX_VIEWER_EXTENSIONS: readonly string[]
/** Largest deck the viewer will render, in bytes. */
export declare const PPTX_VIEWER_MAX_BYTES: number
/** @param path - candidate file path. @returns true when it names a deck this viewer claims. */
export declare function isDeckPath(path: unknown): boolean
/** What one render produced. */
export interface PptxPages {
  readonly root: string
  readonly digest: string
  readonly engine: string
  readonly pages: readonly number[]
  readonly skipped: readonly string[]
}
/** The viewer service. */
export interface PptxViewerService {
  registerRoute(ctx: unknown): void
  ensurePages(file: string, options?: { force?: boolean }): Promise<PptxPages>
  isDeckPath(path: unknown): boolean
}
/**
 * Build the viewer service for one plugin instance.
 *
 * @param cliPath - absolute path of the packaged CLI.
 * @param options.cacheRoot - plugin home for rendered pages.
 * @param options.resolveNode - Node executable used for CLI children.
 * @param options.runCli - CLI runner override for tests.
 */
export declare function createPptxViewerService(cliPath: string, options?: { cacheRoot?: string; resolveNode?: () => string; runCli?: (args: string[], signal?: AbortSignal) => Promise<{ stdout: string; stderr: string }> }): PptxViewerService