/** Authenticated, local-only ChatGPT API transport shared by the export engine. */
export interface ChatGptApi {
  get(path: string, workspaceId?: string | null): Promise<unknown>;
  cancel(): void;
}
