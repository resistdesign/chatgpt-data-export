/**
 * One-click diagnostic observer for the application's OWN ChatGPT window.
 *
 * This module never retains an unredacted URL, a filename, an identifier,
 * credentials, the request/response headers or message content.
 * It produces only predefined route labels and allowlisted query key names.
 */
export interface ObservedFileRequest {
  route: string;
  method: 'GET' | 'POST' | 'other';
  queryKeys: string[];
  otherQueryKeys: number;
  status: string;
  /** Only literal true/false values. Opaque values are never retained. */
  booleans?: { inline?: boolean; download_intent?: boolean };
  /** Allowlisted header names only. Header values are discarded. */
  headerNames?: string[];
}
const knownQueryKeys = new Set([
  'gizmo_id', 'conversation_id', 'check_context_scopes_for_conversation_id',
  'check_context_scopes_for_gizmo_id', 'download_intent', 'inline', 'post_id',
  'file_id', 'limit', 'offset', 'cursor', 'id',
]);

const allowedHeaderNames = new Set([
  'authorization', 'chatgpt-account-id', 'cookie', 'origin',
  'referer', 'accept', 'content-type', 'x-requested-with',
]);
export function safeRequestHeaderNames(headers: Record<string, unknown> | undefined): string[] {
  return [...new Set(Object.keys(headers ?? {})
    .map(key => key.toLowerCase())
    .filter(name => allowedHeaderNames.has(name)))].sort();
}

export function summarizeFileRequest(
  input: string,
  statusCode: number,
  requestMethod = 'GET',
  headerNames: readonly string[] = [],
): ObservedFileRequest | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.origin !== 'https://chatgpt.com' || !url.pathname.startsWith('/backend-api/')) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  let route = '';
  if (parts[1] === 'files') {
    if (parts[2] === 'download' && parts.length >= 4) route = '/backend-api/files/download/{file-id}';
    else if (parts[3] === 'download' && parts.length === 4) route = '/backend-api/files/{file-id}/download';
    else if (parts[3] === 'simple' && parts.length === 4) route = '/backend-api/files/{file-id}/simple';
    else route = '/backend-api/files/{other}';
  } else if (parts[1] === 'gizmos' && parts[2]?.startsWith('g-p-') &&
    (parts.includes('files') || parts.includes('download'))) {
    route = '/backend-api/gizmos/{project-id}/{file-route}';
  } else if ((parts[1] === 'conversations' || parts[1] === 'conversation') &&
    (parts.includes('files') || parts.includes('download'))) {
    route = '/backend-api/conversation/{conversation-id}/{file-route}';
  } else if (parts[1] === 'estuary' && parts[2] === 'content') {
    route = '/backend-api/estuary/content';
  } else if (parts.some(p => p === 'download' || p === 'files')) {
    route = '/backend-api/{other-file-route}';
  }
  if (!route) return null;
  const keys = [...new Set(url.searchParams.keys())];
  const queryKeys = keys.filter(key => knownQueryKeys.has(key)).sort();
  const otherQueryKeys = keys.length - queryKeys.length;
  const method = requestMethod === 'GET' || requestMethod === 'POST' ? requestMethod : 'other';
  const status = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? 'HTTP ' + statusCode : 'unknown';
  const booleans: NonNullable<ObservedFileRequest['booleans']> = {};
  for (const key of ['inline', 'download_intent'] as const) {
    const value = url.searchParams.get(key);
    if (value === 'true' || value === 'false') booleans[key] = value === 'true';
  }
  const safeNames = [...new Set(headerNames
    .map(name => name.toLowerCase()).filter(name => allowedHeaderNames.has(name)))].sort();
  return {
    route, method, queryKeys, otherQueryKeys, status,
    ...(Object.keys(booleans).length ? { booleans } : {}),
    ...(safeNames.length ? { headerNames: safeNames } : {}),
  };
}

export function formatObservedRequests(requests: ReadonlyArray<ObservedFileRequest>): string[] {
  return requests.map((request, index) => {
    const params = request.queryKeys.length ? request.queryKeys.join(', ') : 'none';
    const extra = request.otherQueryKeys ? ` + ${request.otherQueryKeys} other key(s)` : '';
    const flags = request.booleans
      ? Object.entries(request.booleans).map(([key, value]) => `${key}=${value}`).join(', ')
      : '';
    const headers = request.headerNames?.length ? request.headerNames.join(', ') : '';
    return `${index + 1}. ${request.method} ${request.route} [${params}${extra}] ${request.status}` +
      (flags ? ` | flags: ${flags}` : '') + (headers ? ` | headers present: ${headers}` : '');
  });
}
