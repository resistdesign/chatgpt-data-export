import { readdir } from 'node:fs/promises';
import { Archive, safeId, type CompletionMarker, type SavedFile } from './archive.js';
import { saveAssets } from './assets.js';
import { discoverWorkspaces, type Inventory, type Workspace } from './discovery.js';
import { ExportCancelledError } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import type { Progress } from './progress.js';

export interface RouteFailure {
  kind: 'project' | 'conversation';
  route: string;
  scope: 'workspace header' | 'default scope';
  result: string;
  attempts: number;
}
export interface ArchiveOverview {
  workspaces: number;
  discovered: number;
  recordedComplete: number;
  recordedPartial: number;
  notYetCaptured: number;
  missingFiles: number;
  projects: number;
  projectFilesMissing: number;
  projectsWithMissing: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  blockers: Record<'permission_error' | 'HTTP 401' | 'HTTP 403' | 'HTTP 404' | 'other', number>;
  /** Sanitized counts of download attempts. This is not a list of filenames or URLs. */
  routeFailures: RouteFailure[];
  /** Checkpoint counts do not constitute a hash verification. */
  verified: false;
}

interface Target {
  workspaceKey: string;
  kind: 'conversation' | 'project';
  ownerId: string;
  fileId: string;
}

interface ScanResult {
  overview: ArchiveOverview | null;
  targets: Target[];
}

export interface RecoveryResult {
  selected: number;
  recovered: number;
  stillMissing: number;
  remainingInArchive: number;
}

function safe(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

async function directories(archive: Archive, parent: string): Promise<string[]> {
  try {
    const entries = await readdir(archive.path(parent), { withFileTypes: true });
    return entries.filter(item => item.isDirectory() && safe(item.name))
      .map(item => item.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Read only local checkpoint metadata, not conversations and not ChatGPT APIs.
 * Avoid hashing every file here: the separate Verify feature owns integrity.
 */
function categorize(reason: string): keyof ArchiveOverview['blockers'] {
  if (/permission_error/i.test(reason)) return 'permission_error';
  if (/HTTP 401/i.test(reason)) return 'HTTP 401';
  if (/HTTP 403/i.test(reason)) return 'HTTP 403';
  if (/HTTP 404/i.test(reason)) return 'HTTP 404';
  return 'other';
}

const ALLOWED_ROUTES = new Set([
  'sandbox-interpreter', 'sandbox-v2', 'sandbox-legacy',
  'conversation-context-scoped', 'conversation-signed', 'conversation-short',
  'conversation-direct', 'project-signed', 'project-direct', 'project-inline', 'project-file',
]);

function sanitizeAttemptResult(reason: unknown): string {
  const value = typeof reason === 'string' ? reason : '';
  if (/permission_error/i.test(value)) return 'permission_error';
  for (const code of [401, 403, 404, 408, 429, 500, 502, 503, 504]) {
    if (new RegExp(`\\bHTTP ${code}\\b`).test(value)) return `HTTP ${code}`;
  }
  if (/No downloadable URL/i.test(value)) return 'no download URL';
  if (/Binary asset endpoint not supported/i.test(value)) return 'unsupported binary transport';
  if (/Untrusted signed asset host/i.test(value)) return 'unsafe destination blocked';
  return 'other';
}

function addAttemptCounts(
  entry: { attempts?: unknown }, kind: RouteFailure['kind'],
  counts: Map<string, RouteFailure>,
): void {
  if (!Array.isArray(entry.attempts)) return;
  for (const attempt of entry.attempts.slice(0, 32)) {
    if (!attempt || typeof attempt !== 'object') continue;
    const item = attempt as Record<string, unknown>;
    const route = typeof item.route === 'string' && ALLOWED_ROUTES.has(item.route)
      ? item.route : 'unrecognized route';
    const scope = item.workspaceHeader === false ? 'default scope' : 'workspace header';
    const result = sanitizeAttemptResult(item.reason);
    const key = JSON.stringify([kind, route, scope, result]);
    const existing = counts.get(key);
    if (existing) existing.attempts++;
    else counts.set(key, { kind, route, scope, result, attempts: 1 });
  }
}

async function scan(output: string): Promise<ScanResult> {
  const archive = new Archive(output);
  const workspaceKeys = await directories(archive, 'workspaces');
  const report = await archive.read<{ at?: string; status?: string }>('report.json');
  const overview: ArchiveOverview = {
    workspaces: 0, discovered: 0, recordedComplete: 0, recordedPartial: 0,
    notYetCaptured: 0, missingFiles: 0, projects: 0, projectFilesMissing: 0,
    projectsWithMissing: 0, lastRunAt: report?.at ?? null,
    lastRunStatus: report?.status ?? null, verified: false,
    blockers: { permission_error: 0, 'HTTP 401': 0, 'HTTP 403': 0, 'HTTP 404': 0, other: 0 },
    routeFailures: [],
  };
  const routeCounts = new Map<string, RouteFailure>();
  const targets: Target[] = [];
  let hasInventory = false;
  for (const workspaceKey of workspaceKeys) {
    const base = `workspaces/${workspaceKey}`;
    const inventory = await archive.read<Inventory>(`${base}/inventory.json`);
    if (!inventory || inventory.schema !== 1 || !Array.isArray(inventory.conversations)) continue;
    hasInventory = true;
    overview.workspaces++;
    overview.discovered += inventory.conversations.length;
    const conversationIds = await directories(archive, `${base}/conversations`);
    for (const id of conversationIds) {
      const marker = await archive.marker(workspaceKey, id);
      if (!marker || marker.schema !== 1 || !marker.raw || !Array.isArray(marker.missing)) continue;
      if (marker.missing.length) overview.recordedPartial++;
      else overview.recordedComplete++;
      overview.missingFiles += marker.missing.length;
      for (const entry of marker.missing) {
        overview.blockers[categorize(entry.reason)]++;
        addAttemptCounts(entry, 'conversation', routeCounts);
        if (safe(entry.id)) targets.push({ workspaceKey, kind: 'conversation', ownerId: id, fileId: entry.id });
      }
    }
    overview.projects += Array.isArray(inventory.projects) ? inventory.projects.length : 0;
    for (const project of inventory.projects ?? []) {
      if (!safe(project.id)) continue;
      const previous = await archive.read<{ missing?: Array<{ id: string }> }>(
        `${base}/projects/${project.id}/assets-index.json`,
      );
      const missing = Array.isArray(previous?.missing) ? previous.missing : [];
      if (missing.length) overview.projectsWithMissing++;
      overview.projectFilesMissing += missing.length;
      overview.missingFiles += missing.length;
      for (const entry of missing) {
        overview.blockers[categorize(String((entry as { reason?: unknown }).reason ?? ''))]++;
        addAttemptCounts(entry as { attempts?: unknown }, 'project', routeCounts);
        if (safe(entry.id)) targets.push({ workspaceKey, kind: 'project', ownerId: project.id, fileId: entry.id });
      }
    }
  }
  overview.notYetCaptured = Math.max(0, overview.discovered - overview.recordedComplete - overview.recordedPartial);
  overview.routeFailures = [...routeCounts.values()]
    .sort((left, right) => right.attempts - left.attempts
      || left.route.localeCompare(right.route) || left.result.localeCompare(right.result));
  return { overview: hasInventory ? overview : null, targets };
}

export async function inspectArchive(output: string): Promise<ArchiveOverview | null> {
  return (await scan(output)).overview;
}

/**
 * Copyable diagnostic text: aggregate counts and known route labels ONLY.
 * No account IDs, file IDs, filenames, paths, raw server messages or URLs.
 */
export async function archiveDiagnosticText(output: string): Promise<string> {
  const overview = await inspectArchive(output);
  if (!overview) return 'ChatGPT Data Export: no local archive inventory found.';
  const categories = Object.entries(overview.blockers)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `  ${reason}: ${count} file records`);
  const routes = overview.routeFailures.slice(0, 30)
    .map(row => `  ${row.kind} / ${row.route} / ${row.scope}: ${row.result} x${row.attempts}`);
  return [
    'ChatGPT Data Export - safe missing-asset diagnostics',
    `Workspaces: ${overview.workspaces}`,
    `Conversations: ${overview.recordedComplete} saved, ${overview.recordedPartial} partial, ${overview.notYetCaptured} not captured`,
    `Missing file references: ${overview.missingFiles}; Project files: ${overview.projectFilesMissing}`,
    'Missing-record categories:', ...(categories.length ? categories : ['  none']),
    'Failed route attempts (not unique files):', ...(routes.length ? routes : ['  no route attempts recorded']),
    'Counts are from local checkpoint metadata, not a network or hash verification.',
  ].join('\n');
}

/**
 * One deliberately bounded, rotating recovery pass. It never calls inventory
 * or conversation detail APIs; raw conversation JSON is loaded from disk.
 */
export async function recoverMissingAssets(
  api: ChatGptApi,
  output: string,
  progress: Progress,
  cancelled: () => boolean,
  limit = 10,
): Promise<RecoveryResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid recovery batch size');
  const archive = new Archive(output);
  const initial = await scan(output);
  if (!initial.overview) throw new Error('No saved archive inventory. Run a small export first.');
  const workspaces = await discoverWorkspaces(api);
  const available = new Map(workspaces.map(workspace => [workspace.key, workspace]));
  const candidates = initial.targets.filter(target => available.has(target.workspaceKey));
  if (!candidates.length) {
    progress.info('No recoverable missing-file records for the signed-in workspace.');
    return { selected: 0, recovered: 0, stillMissing: 0, remainingInArchive: initial.overview.missingFiles };
  }

  // Rotate the small batch so a permanently denied asset cannot block later
  // assets on every repeated click.
  const previousCursor = await archive.read<{ next?: number }>('recovery-cursor.json');
  const start = Math.max(0, Math.floor(previousCursor?.next ?? 0)) % candidates.length;
  const selected = Array.from({ length: Math.min(limit, candidates.length) },
    (_, i) => candidates[(start + i) % candidates.length]!);
  await archive.json('recovery-cursor.json', {
    schema: 1, next: (start + selected.length) % candidates.length, at: new Date().toISOString(),
  });
  const groups = new Map<string, { workspace: Workspace; kind: Target['kind']; ownerId: string; ids: Set<string> }>();
  for (const target of selected) {
    const groupKey = `${target.workspaceKey}/${target.kind}/${target.ownerId}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        workspace: available.get(target.workspaceKey)!, kind: target.kind,
        ownerId: target.ownerId, ids: new Set<string>(),
      };
      groups.set(groupKey, group);
    }
    group.ids.add(target.fileId);
  }

  let processed = 0;
  let recovered = 0;
  progress.set('Recovering missing files', 0, selected.length, 'Using stored checkpoints; no conversation inventory requests');
  for (const group of groups.values()) {
    if (cancelled()) throw new ExportCancelledError();
    const { workspace, kind, ownerId, ids } = group;
    const base = `workspaces/${safeId(workspace.key)}`;
    const root = `${base}/${kind === 'project' ? 'projects' : 'conversations'}/${safeId(ownerId)}`;
    const before = ids.size;
    let after = before;
    const onProgress = (asset: { processed: number; total: number; current: number; method: string }): void => {
      progress.set('Recovering missing files', processed + asset.processed, selected.length,
        `${kind === 'project' ? 'Project' : 'Conversation'} file ${asset.current}/${asset.total}: ${asset.method}`);
    };

    if (kind === 'conversation') {
      const marker = await archive.marker(workspace.key, ownerId);
      if (marker && await archive.verified(marker.raw)) {
        const source = await archive.read<unknown>(marker.raw.path);
        if (source !== undefined) {
          const assets = await saveAssets(api, archive, workspace, root, source, {
            conversationId: ownerId, existing: marker.files, existingMissing: marker.missing,
            onlyIds: ids, onProgress,
          });
          await archive.json(`${root}/complete.json`, {
            ...marker, files: assets.files, missing: assets.missing, completedAt: new Date().toISOString(),
          } satisfies CompletionMarker);
          after = assets.missing.filter(item => ids.has(item.id)).length;
        }
      } else {
        progress.info('A stored conversation source could not be verified; it was left untouched.');
      }
    } else {
      const inventory = await archive.read<Inventory>(`${base}/inventory.json`);
      const project = inventory?.projects.find(item => item.id === ownerId);
      const previous = await archive.read<{ files: SavedFile[]; missing: Array<{ id: string; reason: string }> }>(
        `${root}/assets-index.json`,
      );
      if (project && previous) {
        const assets = await saveAssets(api, archive, workspace, root, project.details ?? project.raw, {
          projectId: ownerId, projectFiles: project.files, existing: previous.files,
          existingMissing: previous.missing, onlyIds: ids, onProgress,
        });
        let manifest = await archive.read<{ files: SavedFile[] }>(`${root}/manifest.json`);
        if (!manifest || !Array.isArray(manifest.files)) {
          const info = await archive.json(`${root}/info.json`, project.details ?? project.raw);
          manifest = { files: [info] };
        }
        const metadata = manifest.files.filter(file => !file.path.startsWith(`${root}/assets/`));
        await archive.json(`${root}/manifest.json`, { files: [...metadata, ...assets.files] });
        after = assets.missing.filter(item => ids.has(item.id)).length;
      }
    }
    recovered += before - after;
    processed += before;
    progress.set('Recovering missing files', processed, selected.length,
      `${processed} checked; ${recovered} recovered; ${processed - recovered} still unavailable`);
    progress.info(`Recovery: ${processed}/${selected.length} checked; ${recovered} recovered.`);
    await archive.journal(workspace.key, {
      event: 'asset-recovery', kind, attempted: before, recovered: before - after,
    });
  }
  const after = await scan(output);
  const result: RecoveryResult = {
    selected: processed, recovered, stillMissing: processed - recovered,
    remainingInArchive: after.overview?.missingFiles ?? 0,
  };
  await archive.json('recovery-latest.json', { ...result, at: new Date().toISOString() });
  return result;
}
