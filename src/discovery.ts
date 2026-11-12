import { safeId, sha256, workspaceKey } from './archive.js';
import { ApiError, ResourceDeniedError, SessionExpiredError } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import type { Progress } from './progress.js';

export interface Workspace { id: string; label: string; key: string; kind: string }
export interface ConversationListing { id: string; title: string; updated: string | number | null; projectId?: string; archived?: boolean; shareId?: string }
export interface ProjectListing { id: string; raw: unknown; details?: unknown; files: unknown[] }
export interface Inventory {
  schema: 1;
  generatedAt: string;
  conversations: ConversationListing[];
  projects: ProjectListing[];
  shared: unknown[];
  warnings: string[];
  scopes: Record<string, 'complete' | 'unavailable'>;
  sync?: { mode: 'recent'; at: string; new: number; updated: number; requests: Record<string, number> };
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
const cursor = (v: unknown): string | null => typeof v === 'string' || typeof v === 'number' ? String(v) : null;
const query = (args: Record<string, string>): string => new URLSearchParams(args).toString();
const isMissing = (e: unknown): boolean => e instanceof ResourceDeniedError || (e instanceof ApiError && !(e instanceof SessionExpiredError) && [403, 404, 405].includes(e.status));

export async function discoverWorkspaces(api: ChatGptApi): Promise<Workspace[]> {
  const raw = record(await api.get('/backend-api/accounts/check/v4-2023-04-27'));
  const accounts = record(raw.accounts);
  const byId = new Map<string, Workspace>();
  for (const [key, value] of Object.entries(accounts)) {
    const entry = record(value);
    const account = record(entry.account);
    const id = str(account.account_id) ?? str(key);
    if (!id || entry.is_deactivated === true) continue;
    byId.set(id, {
      id,
      label: str(account.account_name) ?? str(account.name) ?? `Workspace ${byId.size + 1}`,
      key: workspaceKey(id),
      kind: str(entry.structure) ?? str(account.account_plan) ?? 'unknown',
    });
  }
  if (!byId.size) throw new Error('Could not discover authenticated workspaces; refusing to report an empty export.');
  return [...byId.values()];
}

export async function buildInventory(api: ChatGptApi, scope: Workspace, progress: Progress): Promise<Inventory> {
  const conversations = new Map<string, ConversationListing>();
  const projects: ProjectListing[] = [];
  const shared: unknown[] = [];
  const warnings: string[] = [];
  const scopes: Inventory['scopes'] = {};
  const add = (item: unknown, extra: Partial<ConversationListing> = {}): void => {
    const v = record(item);
    const id = str(v.id) ?? str(v.conversation_id);
    if (!id || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) return;
    const current = conversations.get(id);
    conversations.set(id, { ...current, id, title: str(v.title) ?? current?.title ?? '', updated: (v.update_time as string | number | null | undefined) ?? current?.updated ?? null, ...extra });
  };
  const pageList = async (name: string, path: (offset: number) => string, consume: (v: unknown) => void, optional: boolean): Promise<void> => {
    const seenPages = new Set<string>();
    let offset = 0;
    try {
      for (let page = 0; page < 1000; page++) {
        const response = record(await api.get(path(offset), scope.id));
        if (!Array.isArray(response.items)) throw new Error(`${name} returned no items array`);
        const items = response.items;
        const first = JSON.stringify(items.map(v => record(v).id ?? record(v).conversation_id));
        if (items.length && seenPages.has(first)) throw new Error(`${name} pagination repeated a page`);
        seenPages.add(first);
        items.forEach(consume);
        progress.set(`Inventory ${name}`, conversations.size, undefined, `${page + 1} pages`);
        if ((page + 1) % 10 === 0) progress.info(`${name} inventory: ${page + 1} pages, ${conversations.size} conversations discovered.`);
        if (items.length < 100) {
          scopes[name] = 'complete';
          progress.info(`${name} inventory completed: ${page + 1} pages, ${conversations.size} conversations discovered so far.`);
          return;
        }
        offset += items.length - 5; // overlap defends against items moving while paging
      }
      throw new Error(`${name} exceeded pagination safety limit`);
    } catch (error) {
      if (optional && isMissing(error)) { scopes[name] = 'unavailable'; warnings.push(`${name}: endpoint returned ${(error as ApiError).status}`); return; }
      throw error;
    }
  };
  await pageList('main', offset => `/backend-api/conversations?${query({ offset: String(offset), limit: '100', order: 'updated' })}`, item => add(item), false);
  await pageList('archived', offset => `/backend-api/conversations?${query({ offset: String(offset), limit: '100', order: 'updated', is_archived: 'true' })}`, item => add(item, { archived: true }), false);
  progress.set('Inventory projects', 0, 0, 'Loading Project sidebar');
  try {
    let cur: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const params: Record<string, string> = { conversations_per_gizmo: '0' };
      if (cur) params.cursor = cur;
      const response = record(await api.get(`/backend-api/gizmos/snorlax/sidebar?${query(params)}`, scope.id));
      if (!Array.isArray(response.items)) throw new Error('Projects endpoint returned no items');

      // Count only new, distinct Projects on this sidebar page, not unrelated GPT entries.
      const pageIds = new Set<string>();
      const pageProjects = response.items.filter(item => {
        const outer = record(record(item).gizmo);
        const nested = record(outer.gizmo);
        const g = Object.keys(nested).length ? nested : outer;
        const id = str(g.id);
        if (!id?.startsWith('g-p-') || projects.some(p => p.id === id) || pageIds.has(id)) return false;
        pageIds.add(id);
        return true;
      });
      progress.set('Inventory projects', 0, pageProjects.length,
        `sidebar page ${i + 1}; ${projects.length} Projects and ${conversations.size} conversations indexed`);

      for (const [projectIndex, item] of pageProjects.entries()) {
        const outer = record(record(item).gizmo);
        const nested = record(outer.gizmo);
        const g = Object.keys(nested).length ? nested : outer;
        const id = safeId(str(g.id)!);
        const project: ProjectListing = { id, raw: item, files: array(outer.files ?? record(item).files) };
        try {
          project.details = await api.get(`/backend-api/gizmos/${encodeURIComponent(id)}`, scope.id);
          const details = record(project.details);
          if (Array.isArray(details.files)) project.files = details.files;
          if (Array.isArray(record(details.gizmo).files)) project.files = record(details.gizmo).files as unknown[];
        } catch (error) { if (!isMissing(error)) throw error; warnings.push(`Project ${id}: details unavailable`); }
        projects.push(project);
        let projectCursor: string | null = null;
        const projectSeen = new Set<string>();
        for (let page = 0; page < 1000; page++) {
          const params = { limit: '50', owned_only: 'false', ...(projectCursor ? { cursor: projectCursor } : {}) };
          const pageResponse = record(await api.get(`/backend-api/gizmos/${encodeURIComponent(id)}/conversations?${query(params)}`, scope.id));
          if (!Array.isArray(pageResponse.items)) throw new Error('Project conversation page malformed');
          pageResponse.items.forEach(v => add(v, { projectId: id }));
          const next = cursor(pageResponse.cursor ?? pageResponse.next_cursor);
          if (!next || !pageResponse.items.length) break;
          if (projectSeen.has(next)) throw new Error('Repeated project cursor');
          projectSeen.add(next);
          projectCursor = next;
          if (page === 999) throw new Error('Project conversation pagination limit');
        }
        progress.set('Inventory projects', projectIndex + 1, pageProjects.length,
          `sidebar page ${i + 1}; ${projects.length} Projects and ${conversations.size} conversations indexed`);
        if ((projectIndex + 1) % 5 === 0 || projectIndex + 1 === pageProjects.length) {
          progress.info(`Project inventory: ${projectIndex + 1}/${pageProjects.length} on sidebar page ${i + 1}; ${projects.length} Projects indexed.`);
        }
      }
      const next = cursor(response.cursor ?? response.next_cursor);
      if (!next || !response.items.length) {
        scopes.projects = 'complete';
        progress.info(`Project inventory completed: ${projects.length} Projects; ${conversations.size} conversations discovered so far.`);
        break;
      }
      if (seen.has(next)) throw new Error('Repeated project sidebar cursor');
      seen.add(next); cur = next;
      if (i === 499) throw new Error('Project sidebar pagination limit');
    }
  } catch (error) { if (!isMissing(error)) throw error; scopes.projects = 'unavailable'; warnings.push('Projects endpoint unavailable'); }
  await pageList('shared', offset => `/backend-api/shared_conversations?${query({ offset: String(offset), limit: '100', order: 'updated' })}`, item => {
    shared.push(item);
    const v = record(item);
    if (str(v.conversation_id)) add({ ...v, id: v.conversation_id }, { shareId: str(v.id) });
  }, true);
  return { schema: 1, generatedAt: new Date().toISOString(), conversations: [...conversations.values()].sort((a, b) => a.id.localeCompare(b.id)), projects, shared, warnings, scopes };
}


/** Fast, lossless union of fresh provider listings with an existing full inventory. */
export interface IncrementalInventoryResult {
  inventory: Inventory;
  changedIds: string[];
  newIds: string[];
  newProjectIds: string[];
  newShareIds: string[];
  requests: Record<string, number>;
}

/**
 * Check newest main, archived, Project and shared listings, stopping when an
 * entire page consists of already-known, unchanged entries. The provider orders
 * main/archived listings by updated time; Project cursors are scanned until the
 * older known portion or the end. A full inventory refresh is still available
 * if deep older changes or provider ordering become uncertain.
 *
 * Build the entire merged inventory IN MEMORY: callers commit it atomically
 * only after successful scans, so interrupted syncs keep the old inventory.
 */
export async function refreshRecentInventory(
  api: ChatGptApi, scope: Workspace, previous: Inventory, progress: Progress,
): Promise<IncrementalInventoryResult> {
  if (previous.schema !== 1 || !Array.isArray(previous.conversations)) {
    throw new Error('Incremental sync requires a valid saved inventory');
  }
  const chats = new Map(previous.conversations.map(item => [item.id, { ...item }]));
  const changed = new Set<string>();
  const newlyAdded = new Set<string>();
  const requests: { main: number; archived: number; projects: number; shared: number } = {
    main: 0, archived: 0, projects: 0, shared: 0,
  };
  const scopes = { ...previous.scopes };
  const warnings = [...previous.warnings];
  const add = (item: unknown, extra: Partial<ConversationListing> = {}): boolean => {
    const value = record(item);
    const id = str(value.id) ?? str(value.conversation_id);
    if (!id || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) return false;
    const old = chats.get(id);
    const title = str(value.title) ?? old?.title ?? '';
    const updated = (value.update_time as string | number | null | undefined) ?? old?.updated ?? null;
    const next: ConversationListing = { ...old, id, title, updated, ...extra };
    chats.set(id, next);
    if (!old) newlyAdded.add(id);
    if (!old || old.updated !== updated || old.title !== title ||
      (extra.projectId !== undefined && old.projectId !== extra.projectId) ||
      // Older baseline inventories omit archived:false on main-list chats.
      // Treat absence as false, otherwise a quick sync would recapture all.
      (extra.archived !== undefined && Boolean(old.archived) !== extra.archived)) changed.add(id);
    return !!old && !changed.has(id);
  };

  const recentPages = async (
    label: 'main' | 'archived' | 'shared',
    endpoint: (offset: number) => string,
    consume: (item: unknown) => boolean,
    optional: boolean,
  ): Promise<void> => {
    let offset = 0;
    const seen = new Set<string>();
    try {
      for (let page = 0; page < 1000; page++) {
        const response = record(await api.get(endpoint(offset), scope.id));
        requests[label]++;
        if (!Array.isArray(response.items)) throw new Error(`Recent ${label} listing returned no items`);
        const items = response.items;
        const fingerprint = JSON.stringify(items.map(item => record(item).id ?? record(item).conversation_id));
        if (items.length && seen.has(fingerprint)) throw new Error(`Recent ${label} pagination repeated a page`);
        seen.add(fingerprint);
        const unchanged = items.filter(consume).length;
        progress.set('Checking for new conversations', changed.size, undefined,
          `${label}: page ${page + 1}; ${newlyAdded.size} new, ${changed.size - newlyAdded.size} updated`);
        if (items.length < 100 || (items.length >= 100 && unchanged >= 95)) {
          scopes[`recent_${label}`] = 'complete';
          return;
        }
        offset += items.length - 5;
      }
      throw new Error(`Recent ${label} listing exceeded pagination limit`);
    } catch (error) {
      if (optional && isMissing(error)) {
        scopes[`recent_${label}`] = 'unavailable';
        warnings.push(`Recent ${label}: endpoint unavailable`);
        return;
      }
      throw error;
    }
  };

  await recentPages('main',
    offset => `/backend-api/conversations?${query({ offset: String(offset), limit: '100', order: 'updated' })}`,
    item => add(item, { archived: false }), false);
  await recentPages('archived',
    offset => `/backend-api/conversations?${query({ offset: String(offset), limit: '100', order: 'updated', is_archived: 'true' })}`,
    item => add(item, { archived: true }), false);

  const projects = new Map(previous.projects.map(item => [item.id, { ...item }]));
  const newProjectIds = new Set<string>();
  try {
    let nextSidebar: string | null = null;
    const visited = new Set<string>();
    for (let sidebarPage = 0; sidebarPage < 500; sidebarPage++) {
      const params: Record<string, string> = { conversations_per_gizmo: '0' };
      if (nextSidebar) params.cursor = nextSidebar;
      const sidebar = record(await api.get(`/backend-api/gizmos/snorlax/sidebar?${query(params)}`, scope.id));
      requests.projects++;
      if (!Array.isArray(sidebar.items)) throw new Error('Recent Project sidebar has no items');
      for (const item of sidebar.items) {
        const outer = record(record(item).gizmo);
        const nested = record(outer.gizmo);
        const gizmo = Object.keys(nested).length ? nested : outer;
        const id = str(gizmo.id);
        if (!id?.startsWith('g-p-') || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) continue;
        const old = projects.get(id);
        if (old) projects.set(id, { ...old, raw: item });
        else {
          const project: ProjectListing = { id, raw: item, files: array(outer.files ?? record(item).files) };
          try {
            project.details = await api.get(`/backend-api/gizmos/${encodeURIComponent(id)}`, scope.id);
            requests.projects++;
            const details = record(project.details);
            if (Array.isArray(details.files)) project.files = details.files;
            if (Array.isArray(record(details.gizmo).files)) project.files = record(details.gizmo).files as unknown[];
          } catch (error) {
            if (!isMissing(error)) throw error;
            warnings.push(`New Project ${id}: details unavailable`);
          }
          projects.set(id, project);
          newProjectIds.add(id);
        }
        let cur: string | null = null;
        const seenCursors = new Set<string>();
        for (let page = 0; page < 1000; page++) {
          const params = { limit: '50', owned_only: 'false', ...(cur ? { cursor: cur } : {}) };
          const response = record(await api.get(
            `/backend-api/gizmos/${encodeURIComponent(id)}/conversations?${query(params)}`, scope.id));
          requests.projects++;
          if (!Array.isArray(response.items)) throw new Error('Recent Project conversation page malformed');
          const unchanged = response.items.filter(item => add(item, { projectId: id })).length;
          const next = cursor(response.cursor ?? response.next_cursor);
          if (!next || !response.items.length || (response.items.length >= 50 && unchanged >= 45)) break;
          if (seenCursors.has(next)) throw new Error('Recent Project cursor repeated');
          seenCursors.add(next);
          cur = next;
          if (page === 999) throw new Error('Recent Project conversation pagination limit');
        }
      }
      progress.set('Checking Project updates', projects.size, undefined,
        `${requests.projects} requests; ${newlyAdded.size} new conversations`);
      const next = cursor(sidebar.cursor ?? sidebar.next_cursor);
      if (!next || !sidebar.items.length) break;
      if (visited.has(next)) throw new Error('Recent Project sidebar cursor repeated');
      visited.add(next);
      nextSidebar = next;
      if (sidebarPage === 499) throw new Error('Recent Project sidebar pagination limit');
    }
    scopes.recent_projects = 'complete';
  } catch (error) {
    if (!isMissing(error)) throw error;
    scopes.recent_projects = 'unavailable';
    warnings.push('Recent Project scan unavailable; Project-only updates may be missing');
  }

  const shares = new Map<string, unknown>();
  const shareKey = (item: unknown): string => str(record(item).id) ??
    str(record(item).share_id) ?? JSON.stringify(item);
  for (const item of previous.shared) shares.set(shareKey(item), item);
  const newShareIds = new Set<string>();
  await recentPages('shared',
    offset => `/backend-api/shared_conversations?${query({ offset: String(offset), limit: '100', order: 'updated' })}`,
    item => {
      const key = shareKey(item);
      const known = shares.has(key);
      shares.set(key, item);
      if (!known) newShareIds.add(key);
      const entry = record(item);
      if (str(entry.conversation_id)) add({ ...entry, id: entry.conversation_id }, { shareId: str(entry.id) });
      return known;
    }, true);

  const inventory: Inventory = {
    ...previous,
    generatedAt: new Date().toISOString(),
    conversations: [...chats.values()].sort((a, b) => a.id.localeCompare(b.id)),
    projects: [...projects.values()],
    shared: [...shares.values()],
    warnings, scopes,
    sync: {
      mode: 'recent', at: new Date().toISOString(),
      new: newlyAdded.size, updated: changed.size - newlyAdded.size, requests,
    },
  };
  progress.info(`Incremental inventory: ${newlyAdded.size} new conversations, ${changed.size - newlyAdded.size} changed; ${Object.values(requests).reduce((a, b) => a + b, 0)} listing requests.`);
  return {
    inventory, changedIds: [...changed], newIds: [...newlyAdded],
    newProjectIds: [...newProjectIds], newShareIds: [...newShareIds], requests,
  };
}

export async function readDetail(api: ChatGptApi, scope: Workspace, id: string): Promise<unknown> {
  safeId(id);
  try {
    const first = record(await api.get(`/backend-api/conversations/${id}?include_has_versions=true&num_turns=100`, scope.id));
    if (Object.keys(first).length === 0 || (first.id !== id && first.conversation_id !== id && record(first.conversation).id !== id)) {
      throw new Error('Conversation identity missing or mismatched');
    }
    if (!Array.isArray(first.messages)) {
      if (first.mapping) return { transport: 'current-full', data: first };
      throw new Error('Conversation response has neither messages nor mapping');
    }
    const pages: unknown[] = [first];
    let current = first;
    const seen = new Set<string>();
    let totalMessages = first.messages.length;
    while (record(current.page_info).has_previous_page === true) {
      const before = str(record(current.page_info).start_cursor);
      if (!before || seen.has(before)) throw new Error('Conversation pagination stuck or repeated cursor');
      seen.add(before);
      if (pages.length >= 1000) throw new Error('Conversation page safety limit');
      const older = record(await api.get(`/backend-api/conversations/${id}/messages?${query({ before })}`, scope.id));
      if (!Array.isArray(older.messages) || older.messages.length === 0) throw new Error('Empty previous messages page');
      if (str(older.id) && older.id !== id) throw new Error('Older page conversation identity mismatch');
      totalMessages += older.messages.length;
      if (totalMessages > 250_000) throw new Error('Conversation message safety limit');
      pages.push(older); current = older;
    }
    return { transport: 'paginated', sourcePages: pages };
  } catch (error) {
    if (!(error instanceof ResourceDeniedError || (error instanceof ApiError && !(error instanceof SessionExpiredError) && [403, 404, 405].includes(error.status)))) throw error;
    const raw = record(await api.get(`/backend-api/conversation/${id}`, scope.id));
    const rawId = str(raw.id) ?? str(raw.conversation_id);
    if (rawId !== id) throw new Error('Legacy conversation identity mismatch');
    if (!raw.mapping) throw new Error('Legacy conversation lacks full mapping');
    return { transport: 'legacy-graph', data: raw };
  }
}

export interface AssetReference { id: string; name: string | null; kind: 'file' | 'sandbox'; messageId?: string; sandboxPath?: string }
export function collectAssets(data: unknown): AssetReference[] {
  const assets = new Map<string, AssetReference>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 70 || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    const node = record(value);
    const idCandidates = [node.file_id, node.id, node.asset_pointer, node.image_asset_pointer];
    for (const candidate of idCandidates) {
      const val = str(candidate)?.replace(/^(sediment|file-service):\/\//, '');
      if (val && /^file_[A-Za-z0-9_-]{3,256}$/.test(val)) {
        assets.set(`file:${val}`, { id: val, kind: 'file', name: str(node.name) ?? str(node.file_name) ?? str(node.filename) ?? null });
      }
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(data);
  const seenText = new WeakSet<object>();

  const sandbox = (value: unknown, messageId: string | null = null, depth = 0): void => {
    if (depth > 70 || !value) return;
    // Most generated attachments are Markdown links inside content.parts,
    // which is an ARRAY OF STRINGS, not an object with a string property.
    if (typeof value === 'string') {
      if (!messageId || !/^[A-Za-z0-9_-]{1,256}$/.test(messageId)) return;
      const regexp = /sandbox:\/mnt\/data\/([^\s)<>"']+)/g;
      for (const match of value.matchAll(regexp)) {
        const sandboxPath = `/mnt/data/${match[1]}`;
        const assetId = 'sandbox_' + sha256(messageId + ':' + sandboxPath).slice(0, 32);
        assets.set('sandbox:' + assetId, {
          id: assetId, kind: 'sandbox', messageId, sandboxPath,
          name: match[1]?.split('/').at(-1) ?? null,
        });
      }
      return;
    }
    if (typeof value !== 'object' || seenText.has(value)) return;
    seenText.add(value);
    if (Array.isArray(value)) { value.forEach(part => sandbox(part, messageId, depth + 1)); return; }
    const node = record(value);
    const id = str(node.id);
    const message = record(node.message);
    const activeId = str(message.id) ?? (node.content !== undefined || node.author !== undefined ? id : undefined) ?? messageId;
    for (const part of Object.values(node)) sandbox(part, activeId, depth + 1);
  };
  sandbox(data);
  return [...assets.values()];
}

export { record, array, str };
