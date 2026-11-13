import { isIP } from 'node:net';
import { ApiError, RateLimitExhausted, SessionExpiredError, SessionCheckError, ExportCancelledError } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import { Archive, safeId, type SavedFile } from './archive.js';
import { collectAssets, record, str, type AssetReference, type Workspace } from './discovery.js';

export interface AssetResult {
  files: SavedFile[];
  missing: Array<{ id: string; reason: string; attempts?: Array<{ route: string; workspaceHeader: boolean; reason: string }> }>;
  /** Number of file references the source metadata actually matched. */
  attempted: number;
  /** Selected missing IDs no longer present in the saved source metadata. */
  unlisted: number;
}
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

/**
 * Bounded route exploration for the automatic bulk attachment pass.
 * A route is identified only by its public route label and header scope:
 * no file IDs, conversation IDs, URLs, tokens, or filenames are retained.
 * Manual recovery deliberately does not use this policy.
 */
export class AutomaticAssetRoutePolicy {
  readonly maxTrialsPerFile = 2;
  private readonly results = new Map<string, { attempts: number; successes: number }>();

  private key(family: string, label: string, workspaceHeader: boolean): string {
    return `${family}:${label}:${workspaceHeader ? 'workspace' : 'default'}`;
  }

  observe(family: string, label: string, workspaceHeader: boolean, succeeded: boolean): void {
    const key = this.key(family, label, workspaceHeader);
    const previous = this.results.get(key) ?? { attempts: 0, successes: 0 };
    this.results.set(key, {
      attempts: previous.attempts + 1,
      successes: previous.successes + Number(succeeded),
    });
  }

  next(
    family: string, variants: readonly Variant[], tried: ReadonlySet<string>,
    preferNoHeader?: string, avoidSameRoute?: string,
  ): { variant: Variant; workspaceHeader: boolean } | undefined {
    const choices = variants.flatMap((variant, order) => [
      { variant, workspaceHeader: true, order },
      { variant, workspaceHeader: false, order },
    ]).filter(item => !tried.has(this.key(family, item.variant.label, item.workspaceHeader)));
    choices.sort((a, b) => {
      const aStats = this.results.get(this.key(family, a.variant.label, a.workspaceHeader));
      const bStats = this.results.get(this.key(family, b.variant.label, b.workspaceHeader));
      const successfulDifference = (bStats?.successes ?? 0) - (aStats?.successes ?? 0);
      if (successfulDifference) return successfulDifference;
      const aPreferred = Number(a.variant.label === preferNoHeader && !a.workspaceHeader);
      const bPreferred = Number(b.variant.label === preferNoHeader && !b.workspaceHeader);
      if (aPreferred !== bPreferred) return bPreferred - aPreferred;
      const aAvoided = Number(a.variant.label === avoidSameRoute);
      const bAvoided = Number(b.variant.label === avoidSameRoute);
      if (aAvoided !== bAvoided) return aAvoided - bAvoided;
      const trialDifference = (aStats?.attempts ?? 0) - (bStats?.attempts ?? 0);
      if (trialDifference) return trialDifference;
      return a.order - b.order || Number(b.workspaceHeader) - Number(a.workspaceHeader);
    });
    const next = choices[0];
    return next ? { variant: next.variant, workspaceHeader: next.workspaceHeader } : undefined;
  }
}

function variantsFor(ref: AssetReference, opts: { conversationId?: string; projectId?: string; projectFiles?: unknown[] }): Variant[] {
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
  // Explicit Project attachments are identified by the Project file list.
  // A conversation which belongs to a Project also has a projectId; it must
  // still use conversation-scoped retrieval instead of this Project-only path.
  if (opts.projectId && opts.projectFiles !== undefined) {
    const project = encodeURIComponent(opts.projectId);
    const live = new URLSearchParams({
      gizmo_id: opts.projectId,
      download_intent: 'true',
      inline: 'false',
    });
    return [
      // Observed from a successful authenticated ChatGPT Project download.
      // Response may be actual bytes OR JSON containing an estuary signed URL.
      { label: 'project-intent', path: `/backend-api/files/download/${id}?${live}`, direct: true },
      { label: 'project-signed', path: `/backend-api/files/download/${id}?gizmo_id=${project}`, direct: false },
      { label: 'project-direct', path: `/backend-api/files/${id}/download?gizmo_id=${project}`, direct: true },
      { label: 'project-inline', path: `/backend-api/files/download/${id}?gizmo_id=${project}&inline=false`, direct: false },
      { label: 'project-file', path: `/backend-api/files/${id}?download=1`, direct: true },
    ];
  }
  const conversation = encodeURIComponent(opts.conversationId ?? '');
  const combined = opts.projectId
    ? [
      {
        label: 'conversation-project-context-scoped',
        path: `/backend-api/files/download/${id}?${new URLSearchParams({
          check_context_scopes_for_conversation_id: opts.conversationId ?? '',
          download_intent: 'true', gizmo_id: opts.projectId,
        })}`,
        direct: true,
      },
      {
        label: 'conversation-project-simple',
        path: `/backend-api/files/${id}/simple?${new URLSearchParams({
          conversation_id: opts.conversationId ?? '', gizmo_id: opts.projectId,
        })}`,
        direct: true,
      },
    ] : [];
  return [
    // Two additional routes observed from a successful ChatGPT conversation
    // within a Project: /files/{id}/simple and download with both context IDs.
    ...combined,
    // Current (2026) ChatGPT attachment workflow scopes access by the
    // conversation and explicitly declares the intent to download.
    // Treat the response as bytes OR a signed-link descriptor.
    { label: 'conversation-context-scoped',
      path: `/backend-api/files/download/${id}?check_context_scopes_for_conversation_id=${conversation}&download_intent=true`,
      direct: true },
    { label: 'conversation-signed', path: `/backend-api/files/download/${id}?conversation_id=${conversation}&inline=false`, direct: false },
    { label: 'conversation-short', path: `/backend-api/files/download/${id}?conversation_id=${conversation}`, direct: false },
    { label: 'conversation-direct', path: `/backend-api/files/${id}/download?conversation_id=${conversation}`, direct: true },
  ];
}

const urlFrom = (value: unknown): string | undefined => {
  const object = record(value);
  const candidates = [object, record(object.data), record(object.file), record(object.download)];
  for (const source of candidates) {
    const url = str(source.download_url) ?? str(source.signed_url) ??
      str(source.presigned_url) ?? str(source.file_url) ?? str(source.url);
    if (url) return url;
  }
  return undefined;
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
    /** Target only selected missing file IDs; retain untouched prior index entries. */
    onlyIds?: ReadonlySet<string>;
    existingMissing?: AssetResult['missing'];
    /** Preserve prior filename metadata during partial recovery. */
    existingNames?: Array<{ id: string; name: string | null }>;
    onProgress?: (update: AssetProgress) => void;
    /** Only bulk sync supplies this: no more than two route trials per file. */
    routePolicy?: AutomaticAssetRoutePolicy;
  },
): Promise<AssetResult> {
  const refs = assetReferences(source, opts.projectFiles);
  const selected = opts.onlyIds ? refs.filter(ref => opts.onlyIds?.has(ref.id)) : refs;
  const unlisted = opts.onlyIds ? Math.max(0, opts.onlyIds.size - selected.length) : 0;
  // Do not rewrite an index when none of its selected IDs exist in the
  // original source metadata. Recovery must report those records separately.
  if (opts.onlyIds && selected.length === 0) {
    return {
      files: opts.existing ?? [], missing: opts.existingMissing ?? [],
      attempted: 0, unlisted,
    };
  }
  const selectedPaths = new Set(selected.map(ref => `${root}/assets/${safeId(ref.id)}`));
  // A targeted pass must NEVER drop unrelated prior files or missing records.
  const files: SavedFile[] = opts.onlyIds
    ? (opts.existing ?? []).filter(file => !selectedPaths.has(file.path))
    : [];
  const missing: AssetResult['missing'] = opts.onlyIds
    ? (opts.existingMissing ?? []).filter(entry => !opts.onlyIds?.has(entry.id))
    : [];
  for (const [assetIndex, ref] of selected.entries()) {
    const update = (method: string, processed = assetIndex): void => {
      opts.onProgress?.({ processed, total: selected.length, current: assetIndex + 1, method });
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
    if (opts.routePolicy) {
      const family = ref.kind === 'sandbox' ? 'sandbox'
        : opts.projectFiles !== undefined ? 'project'
        : opts.projectId ? 'project-conversation' : 'conversation';
      const variants = variantsFor(ref, opts);
      const tried = new Set<string>();
      let preferNoHeader: string | undefined;
      let avoidSameRoute: string | undefined;
      for (let trial = 0; trial < opts.routePolicy.maxTrialsPerFile && !downloaded; trial++) {
        const choice = opts.routePolicy.next(family, variants, tried, preferNoHeader, avoidSameRoute);
        if (!choice) break;
        const { variant, workspaceHeader } = choice;
        tried.add(`${family}:${variant.label}:${workspaceHeader ? 'workspace' : 'default'}`);
        update(`${workspaceHeader ? 'Trying' : 'Trying without workspace header:'} ${variant.label} download (route ${trial + 1}/${opts.routePolicy.maxTrialsPerFile})`);
        try {
          downloaded = await downloadVariant(api, archive, output, variant, workspaceHeader ? workspace.id : null);
          opts.routePolicy.observe(family, variant.label, workspaceHeader, true);
        } catch (error) {
          if (fatal(error)) throw error;
          attempts.push({ route: variant.label, workspaceHeader, reason: shortReason(error) });
          opts.routePolicy.observe(family, variant.label, workspaceHeader, false);
          // An explicit 403/permission denial may be header-sensitive.
          // For HTTP 404, try a different route rather than duplicating the
          // same likely-missing endpoint without the header.
          // A resource-level 401 means the authenticated account was denied.
          // Trying legacy variants automatically after this produces repeated
          // authorization checks without evidence the file can be accessed.
          // The user can explicitly invoke the thorough manual 10-file pass.
          if (error instanceof ApiError && error.status === 401) {
            update('HTTP 401: account denied this file; skipping other automatic routes');
            break;
          }
          const is404 = error instanceof ApiError && error.status === 404;
          preferNoHeader = workspaceHeader && recoverableScope(error) && !is404
            ? variant.label : undefined;
          avoidSameRoute = is404 ? variant.label : undefined;
        }
      }
    } else {
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
    }
    if (downloaded) files.push(downloaded);
    else missing.push({
      id: ref.id,
      reason: `${opts.routePolicy ? 'Automatic route budget exhausted' : 'No accessible download'} after ${attempts.length} attempts; ${attempts.at(-1)?.reason ?? 'no supported route'}`,
      attempts,
    });
    update(downloaded ? 'File saved' : 'File unavailable', assetIndex + 1);
  }
  await archive.json(`${root}/assets-index.json`, {
    files, missing,
    names: opts.onlyIds && opts.existingNames
      ? opts.existingNames
      : refs.map(ref => ({ id: ref.id, name: ref.name })),
  });
  return { files, missing, attempted: selected.length, unlisted };
}


/**
 * Queue attachments for a later pass, without making ANY file API requests.
 * Used for history-first exports so broken Project files cannot block chats.
 *
 * Existing verified files are preserved. Every uncollected reference receives
 * an explicit "deferred" marker, so no partial archive claims completeness.
 */
export async function deferAssets(
  archive: Archive,
  root: string,
  source: unknown,
  opts: {
    projectFiles?: unknown[];
    existing?: SavedFile[];
    existingMissing?: AssetResult['missing'];
    existingNames?: Array<{ id: string; name: string | null }>;
  } = {},
): Promise<AssetResult> {
  const refs = assetReferences(source, opts.projectFiles);
  const files: SavedFile[] = [];
  for (const previous of opts.existing ?? []) {
    if (await archive.verified(previous)) files.push(previous);
  }
  const savedPaths = new Set(files.map(file => file.path));
  const missing = [...(opts.existingMissing ?? [])];
  const covered = new Set(missing.map(item => item.id));
  for (const ref of refs) {
    if (savedPaths.has(`${root}/assets/${safeId(ref.id)}`)) continue;
    if (!covered.has(ref.id)) {
      missing.push({ id: ref.id, reason: 'Download deferred to later file recovery' });
      covered.add(ref.id);
    }
  }
  // If a previously downloaded file fails verification, it stays reported as
  // missing; do not silently discard its reference or mark it complete.
  for (const file of opts.existing ?? []) {
    if (savedPaths.has(file.path)) continue;
    const id = file.path.split('/').at(-1);
    if (id && !covered.has(id)) {
      missing.push({ id, reason: 'Previously saved file requires verification or re-download' });
      covered.add(id);
    }
  }
  const names = new Map<string, string | null>();
  for (const item of opts.existingNames ?? []) names.set(item.id, item.name);
  for (const ref of refs) names.set(ref.id, ref.name);
  await archive.json(`${root}/assets-index.json`, {
    files, missing, names: [...names].map(([id, name]) => ({ id, name })),
  });
  return { files, missing, attempted: 0, unlisted: 0 };
}
