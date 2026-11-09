import { isIP } from 'node:net';
import { ApiError, RateLimitExhausted, type ChatGptBrowser } from './browser.js';
import { Archive, safeId, type SavedFile } from './archive.js';
import { collectAssets, record, str, type AssetReference, type Workspace } from './discovery.js';

export interface AssetResult { files: SavedFile[]; missing: Array<{ id: string; reason: string }> }

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

async function signedFetch(rawUrl: string): Promise<Response> {
  let url = safeDownloadUrl(rawUrl);
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Signed asset redirect has no Location');
      url = safeDownloadUrl(new URL(location, url).toString());
      continue;
    }
    return response;
  }
  throw new Error('Too many asset redirects');
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
  api: ChatGptBrowser,
  archive: Archive,
  workspace: Workspace,
  root: string,
  source: unknown,
  opts: { conversationId?: string; projectId?: string; projectFiles?: unknown[]; existing?: SavedFile[] },
): Promise<AssetResult> {
  const files: SavedFile[] = [];
  const missing: AssetResult['missing'] = [];
  for (const ref of assetReferences(source, opts.projectFiles)) {
    const output = `${root}/assets/${safeId(ref.id)}`;
    const previous = opts.existing?.find(f => f.path === output);
    if (previous && await archive.verified(previous)) { files.push(previous); continue; }
    try {
      const params = new URLSearchParams({ inline: 'false' });
      if (opts.conversationId) params.set('conversation_id', opts.conversationId);
      if (opts.projectId) params.set('gizmo_id', opts.projectId);
      const path = ref.kind === 'sandbox'
        ? `/backend-api/conversation/${encodeURIComponent(opts.conversationId ?? '')}/interpreter/download?${new URLSearchParams({ message_id: ref.messageId ?? '', sandbox_path: ref.sandboxPath ?? '' })}`
        : `/backend-api/files/download/${encodeURIComponent(ref.id)}?${params.toString()}`;
      const descriptor = record(await api.get(path, workspace.id));
      const url = str(descriptor.download_url);
      if (!url || (str(descriptor.status) && descriptor.status !== 'success')) throw new Error(`No downloadable URL (${str(descriptor.error_code) ?? str(descriptor.status) ?? 'unavailable'})`);
      let downloaded: SavedFile | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await signedFetch(url);
        if (response.status === 429 || response.status >= 500) {
          await new Promise(resolve => setTimeout(resolve, Math.min(15_000, 1000 * 2 ** attempt)));
          continue;
        }
        if (!response.ok || !response.body) throw new Error(`Asset HTTP ${response.status}`);
        downloaded = await archive.stream(output, response.body);
        break;
      }
      if (!downloaded) throw new Error('Asset fetch retry limit reached');
      files.push(downloaded);
    } catch (error) {
      if (error instanceof RateLimitExhausted || (error instanceof ApiError && error.status === 401)) throw error;
      missing.push({ id: ref.id, reason: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    }
  }
  await archive.json(`${root}/assets-index.json`, { files, missing, names: assetReferences(source, opts.projectFiles).map(x => ({ id: x.id, name: x.name })) });
  return { files, missing };
}
