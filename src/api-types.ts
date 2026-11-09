/** Authenticated, local-only ChatGPT API transport shared by the export engine. */
export interface ChatGptApi {
  get(path: string, workspaceId?: string | null): Promise<unknown>;
  /** Authorized binary downloads on chatgpt.com. Never follows redirects off origin. */
  openFile?(path: string, workspaceId?: string | null): Promise<Response>;
  cancel(): void;
}
