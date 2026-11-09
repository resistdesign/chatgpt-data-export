import { isIP } from 'node:net';
import { ApiError, RateLimitExhausted, SessionExpiredError, SessionCheckError, ExportCancelledError } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import { Archive, safeId, type SavedFile } from './archive.js';
import { collectAssets, record, str, type AssetReference, type Workspace } from './discovery.js';

export interface AssetResult { files: SavedFile[]; missing: Array<{ id: string; reason: string; attempts?: Array<{ route: string; workspaceHeader: boolean; reason: string }> }> }
/** Per-file status with no private filenames, tokens, or signed URLs. */
export interface AssetProgress { processed: number; total: number; current: number; method: string }

/** Signed URLs never receive bearer credentials; enforce HTTPS and known asset/CDN hosts. */
export function safeDownloadUrl(input: string): URL {
  const url = new URL(input, 'https://chatgpt.com');
  const host = url.hostname.toLowerCase();
  const allowed = ['chatgpt.com', 'openai.com', 'oaiusercontent.com', 'oaistatic.com', 'openaiusercontent.com', 'blob.core.windows.net', 'amazonaws.com', 'cloudfront.net'];
  if (url.protocol !== 'https:' || url.username || url.password || isIP(host) !== 0 || !allowed.some(d => host === d || host.endsWith('.' + d))) {
    throw new Error(`Untrusted signed asset host: ${host}`);
  }
  return url;
}


type Attempt = { route: string; workspaceHeader: boolean; reason: string };
type Variant = { label: string; path: string; direct: boolean };

function variantsFor(ref: AssetReference, opts: { conversationId?: string; projectId?: string }): Variant[] {
  if (ref.kind === 'sandbox') {
    const base = `/backend-api/conversation/${encodeURIComponent(opts.conversationId ?? '')}`;
    const query = new URLSearchParams({ message_id: ref.messageId ?? '', sandbox_path: ref.sandboxPath ?? '' });
    return [
      { label: 'sandbox-interpreter', path: `${base}/interpreter/download?${query}`, direct: true },
      { label: 'sandbox-v2', path: `${base}/download_from_sandbox/v2?${query}`, direct: true },
      { label: 'sandbox-legacy', path: `${base}/download_from_sandbox?${query}`, direct: true },
    ];
  }
  const id = encodeURIComponent(ref.id);
  if (opts.projectId) {
    const project = encodeURIComponent(opts.projectId);
    return [
      // Team/Business Project files require gizmo_id; an inline-only request
      // is not interchangeable with the Project's own download route.
      { label: 'project-signed', path: `/backend-api/files/download/${id}?gizmo_id=${project}`, direct: false },
      { label: 'project-direct', path: `/backend-api/files/${id}/download?gizmo_id=${project}`, direct: true },
      { label: 'project-inline', path: `/backend-api/files/download/${id}?gizmo_id=${project}&inline=false`, direct: false },
      { label: 'project-file', path: `/backend-api/files/${id}?download=1`, direct: true },
    ];
  }
  const conversation = encodeURIComponent(opts.conversationId ?? '');
  return [
    { label: 'conversation-signed', path: `/backend-api/files/download/${id}?conversation_id=${conversation}&inline=false`, direct: false },
    { label: 'conversation-short', path: `/backend-api/files/download/${id}?conversation_id=${conversation}`, direct: false },
    { label: 'conversation-direct', path: `/backend-api/files/${id}/download?conversation_id=${conversation}`, direct: true },
  ];
}

const urlFrom = (value: unknown): string | undefined => {
  const object = record(value);
  return str(object.download_url) ?? str(object.signed_url) ??
    str(object.presigned_url) ?? str(object.file_url) ?? str(object.url);
};
const responseReason = (value: unknown): string => {
  const object = record(value);
  return str(object.error_code) ?? str(object.status) ??
    str(object.detail) ?? str(object.error) ?? 'download URL missing';
};
function recoverableScope(error: unknown): boolean {
  // Some ChatGPT workspaces conceal inaccessible files as 404 when the
  // explicit workspace header is present; try the session's default scope.
  return error instanceof ApiError && [401, 403, 404].includes(error.status) ||
    error instanceof Error && /permission_error|unauthorized/i.test(error.message);
}
function fatal(error: unknown): boolean {
  return error instanceof RateLimitExhausted || error instanceof SessionExpiredError ||
    error instanceof SessionCheckError || error instanceof ExportCancelledError;
}
function shortReason(error: unknown): string {
  if (error instanceof ApiError) return `HTTP ${error.status}`;
  return (error instanceof Error ? error.message : String(error)).slice(0,110);
}
function redirected(response: Response): boolean {
  return [301, 302, 303, 307, 308].includes(response.status);
}

/**
 * Credentials may reach ONLY the ChatGPT origin; cross-origin signed URLs
 * are fetched with no cookies or bearer token. Every redirect is checked.
 */
async function signedFetch(
  rawUrl: string,
  api: ChatGptApi,
  workspaceId: string | null,
): Promise<Response> {
  let url = safeDownloadUrl(rawUrl);
  for (let attempt = 0; attempt < 6; attempt++) {
    let response: Response;
    if (url.origin === 'https://chatgpt.com') {
      if (!api.openFile) throw new Error('ChatGPT-origin asset requires an authenticated binary transport');
      response = await api.openFile(url.pathname + url.search, workspaceId);
    } else {
      response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(120_000) });
    }
    if (redirected(response)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Signed asset redirect has no Location');
      url = safeDownloadUrl(new URL(location, url).toString());
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 2) {
        if (response.status === 429) throw new RateLimitExhausted('signed asset bytes');
        return response;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
      continue;
    }
    return response;
  }
  throw new Error('Too many signed asset redirects');
}

async function saveResponse(
  response: Response,
  api: ChatGptApi,
  archive: Archive,
  output: string,
  workspaceId: string | null,
): Promise<SavedFile> {
  if (redirected(response)) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Asset redirect has no Location');
    return saveResponse(await signedFetch(new URL(location, 'https://chatgpt.com').href, api, workspaceId), api, archive, output, workspaceId);
  }
  if (response.status === 429) throw new RateLimitExhausted('asset binary download');
  if (!response.ok) throw new ApiError(response.status, 'asset-binary', `Asset HTTP ${response.status}`);
  const mediaType = (response.headers.get('content-type') ?? '').toLowerCase();
  // Some direct endpoints return a JSON signed-link descriptor rather than bytes.
  if (/application\/(?:[\w.+-]*\+)?json/.test(mediaType)) {
    const data: unknown = await response.json();
    const url = urlFrom(data);
    if (!url || (str(record(data).status) && record(data).status !== 'success')) {
      throw new Error(`No downloadable URL (${responseReason(data)})`);
    }
    const signed = await signedFetch(url, api, workspaceId);
    if (redirected(signed)) throw new Error('Signed asset redirect unresolved');
    if (!signed.ok || !signed.body) throw new ApiError(signed.status, 'asset-signed', `Asset HTTP ${signed.status}`);
    if (/application\/(?:[\w.+-]*\+)?json/.test(signed.headers.get('content-type') ?? '')) {
      throw new Error('Signed asset returned JSON instead of file bytes');
    }
    return archive.stream(output, signed.body);
  }
  if (/text\/html/.test(mediaType)) throw new Error('Asset endpoint returned HTML, not a file');
  if (!response.body) throw new Error('Asset response contained no file data');
  return archive.stream(output, response.body);
}

async function downloadVariant(
  api: ChatGptApi,
  archive: Archive,
  output: string,
  variant: Variant,
  workspaceId: string | null,
): Promise<SavedFile> {
  if (variant.direct) {
    if (!api.openFile) throw new Error('Binary asset endpoint not supported by this transport');
    const response = await api.openFile(variant.path, workspaceId);
    return saveResponse(response, api, archive, output, workspaceId);
  }
  const data = record(await api.get(variant.path, workspaceId));
  const url = urlFrom(data);
  if (!url || (str(data.status) && data.status !== 'success')) {
    throw new Error(`No downloadable URL (${responseReason(data)})`);
  }
  return saveResponse(await signedFetch(url, api, workspaceId), api, archive, output, workspaceId);
}

function projectAssetReferences(projectFiles: unknown[]): AssetReference[] {
  const refs = new Map<string, AssetReference>();
  for (const file of projectFiles) {
    const node = record(file);
    const id = str(node.file_id) ?? str(node.id);
    if (id && /^[A-Za-z0-9_-]{1,256}$/.test(id)) refs.set(id, { id, kind: 'file', name: str(node.name) ?? str(node.file_name) ?? null });
  }
  return [...refs.values()];
}

export function assetReferences(source: unknown, projectFiles?: unknown[]): AssetReference[] {
  return projectFiles ? projectAssetReferences(projectFiles) : collectAssets(source);
}


export async function saveAssets(
  api: ChatGptApi,
  archive: Archive,
  workspace: Workspace,
  root: string,
  source: unknown,
  opts: {
    conversationId?: string; projectId?: string; projectFiles?: unknown[]; existing?: SavedFile[];
    onProgress?: (update: AssetProgress) => void;
  },
): Promise<AssetResult> {
  const files: SavedFile[] = [];
  const missing: AssetResult['missing'] = [];
  const refs = assetReferences(source, opts.projectFiles);
  for (const [assetIndex, ref] of refs.entries()) {
    const update = (method: string, processed = assetIndex): void => {
      opts.onProgress?.({ processed, total: refs.length, current: assetIndex + 1, method });
    };
    update('Checking existing file');
    const output = `${root}/assets/${safeId(ref.id)}`;
    const previous = opts.existing?.find(file => file.path === output);
    if (previous && await archive.verified(previous)) {
      files.push(previous);
      update('Existing file verified', assetIndex + 1);
      continue;
    }

    const attempts: Attempt[] = [];
    let downloaded: SavedFile | undefined;
    for (const variant of variantsFor(ref, opts)) {
      if (downloaded) break;
      update(`Trying ${variant.label} download`);
      // A rejected workspace header does not necessarily mean the browser
      // account lacks access; retry that route once without the header.
      let retryWithoutHeader = false;
      try {
        downloaded = await downloadVariant(api, archive, output, variant, workspace.id);
      } catch (error) {
        if (fatal(error)) throw error;
        attempts.push({ route: variant.label, workspaceHeader: true, reason: shortReason(error) });
        retryWithoutHeader = recoverableScope(error);
      }
      if (!downloaded && retryWithoutHeader) {
        update(`Retrying ${variant.label} without workspace header`);
        try {
          downloaded = await downloadVariant(api, archive, output, variant, null);
        } catch (error) {
          if (fatal(error)) throw error;
          attempts.push({ route: variant.label, workspaceHeader: false, reason: shortReason(error) });
        }
      }
    }
    if (downloaded) files.push(downloaded);
    else missing.push({
      id: ref.id,
      reason: `No accessible download after ${attempts.length} attempts; ${attempts.at(-1)?.reason ?? 'no supported route'}`,
      attempts,
    });
    update(downloaded ? 'File saved' : 'File unavailable', assetIndex + 1);
  }
  await archive.json(`${root}/assets-index.json`, {
    files, missing,
    names: refs.map(ref => ({ id: ref.id, name: ref.name })),
  });
  return { files, missing };
}
