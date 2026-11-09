import { readdir } from 'node:fs/promises';
import { Archive, type CompletionMarker, type SavedFile } from './archive.js';
import { ApiError, RateLimitExhausted } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import { saveAssets } from './assets.js';
import { buildInventory, discoverWorkspaces, readDetail, record, array, str, type Inventory, type Workspace } from './discovery.js';
import type { Progress } from './progress.js';

export interface ExportOptions {
  output: string;
  concurrency: number;
  max: number | undefined;
  assets: boolean;
  refresh: boolean;
}

const optionalPaths: Record<string, string> = {
  memories_legacy: '/backend-api/memories?include_memory_entries=true',
  custom_instructions: '/backend-api/user_system_messages',
  settings: '/backend-api/settings',
  beta_features: '/backend-api/settings/beta_features',
  library: '/backend-api/files/library',
};

async function captureAccount(api: ChatGptApi, archive: Archive, workspace: Workspace, progress: Progress): Promise<Record<string, string>> {
  const root = `workspaces/${workspace.key}`;
  const result: Record<string, string> = {};
  const savedFiles: SavedFile[] = [];
  for (const [name, path] of Object.entries(optionalPaths)) {
    progress.set(`Account: ${name}`);
    try { savedFiles.push(await archive.json(`${root}/account/${name}.json`, await api.get(path, workspace.id))); result[name] = 'saved'; }
    catch (error) {
      if (error instanceof ApiError && [403, 404, 405].includes(error.status)) result[name] = `unavailable (HTTP ${error.status})`;
      else throw error;
    }
  }
  // Custom GPT configurations have a separate public API. Save the provider objects unchanged.
  try {
    const gpts: unknown[] = [];
    let cur: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const query = new URLSearchParams({ limit: '20', ...(cur ? { cursor: cur } : {}) });
      const data = record(await api.get(`/public-api/gizmos/discovery/mine?${query}`, workspace.id));
      const items = array(record(data.list).items ?? data.items ?? data.gizmos);
      gpts.push(...items);
      const next = str(record(data.list).cursor ?? data.cursor ?? data.next_cursor) ?? null;
      if (!next || !items.length) break;
      if (seen.has(next)) throw new Error('Custom GPT pagination repeated a cursor');
      seen.add(next); cur = next;
      if (i === 499) throw new Error('Custom GPT pagination limit');
    }
    savedFiles.push(await archive.json(`${root}/account/custom_gpts.json`, gpts));
    result.custom_gpts = `saved (${gpts.length})`;
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 405].includes(error.status)) result.custom_gpts = `unavailable (HTTP ${error.status})`;
    else throw error;
  }
  await archive.json(`${root}/account/status.json`, result);
  await archive.json(`${root}/account/manifest.json`, { files: savedFiles });
  return result;
}

export async function exportWorkspace(api: ChatGptApi, archive: Archive, workspace: Workspace, progress: Progress, options: ExportOptions, cancelled: () => boolean): Promise<Record<string, unknown>> {
  const root = `workspaces/${workspace.key}`;
  const previous = options.refresh ? undefined : await archive.read<Inventory>(`${root}/inventory.json`);
  const inventory = previous?.schema === 1 && previous.scopes.main === 'complete' && previous.scopes.archived === 'complete'
    ? previous : await buildInventory(api, workspace, progress);
  if (inventory !== previous) await archive.json(`${root}/inventory.json`, inventory);
  progress.info(`Workspace ${workspace.label}: ${inventory.conversations.length} conversations, ${inventory.projects.length} Projects. Inventory ${previous === inventory ? 'resumed' : 'saved'}.`);
  const account = await captureAccount(api, archive, workspace, progress);
  const projectMissing: string[] = [];
  const sharedFailures: string[] = [];
  progress.set('Saving Project files', 0, inventory.projects.length, 'Checking Project metadata and attached files');
  for (const [index, project] of inventory.projects.entries()) {
    const projectRoot = `${root}/projects/${project.id}`;
    const info = await archive.json(`${projectRoot}/info.json`, project.details ?? project.raw);
    let projectFiles: SavedFile[] = [];
    if (options.assets) {
      const previousAssets = await archive.read<{ files: SavedFile[] }>(`${projectRoot}/assets-index.json`);
      const assets = await saveAssets(api, archive, workspace, projectRoot, project.details ?? project.raw, { projectId: project.id, projectFiles: project.files, existing: previousAssets?.files });
      projectFiles = assets.files;
      if (assets.missing.length) projectMissing.push(project.id);
    }
    await archive.json(`${projectRoot}/manifest.json`, { files: [info, ...projectFiles] });
    progress.set('Saving Project files', index + 1, inventory.projects.length,
      `${index + 1} Projects checked; ${projectMissing.length} missing asset sets`);
    if ((index + 1) % 10 === 0 || index + 1 === inventory.projects.length) {
      progress.info(`Project files: ${index + 1}/${inventory.projects.length} checked; ${projectMissing.length} missing asset sets.`);
    }
  }
  // Shared-only links may not have an owner conversation ID. Keep their raw listing
  // and attempt to capture the share itself without pretending it's a normal chat.
  for (const share of inventory.shared) {
    const entry = record(share);
    if (str(entry.conversation_id)) continue;
    const shareId = str(entry.id) ?? str(entry.share_id);
    if (!shareId || !/^[A-Za-z0-9_-]{1,256}$/.test(shareId)) { sharedFailures.push('unknown share identifier'); continue; }
    try {
      const detail = await api.get(`/backend-api/share/${shareId}`, workspace.id);
      await archive.json(`${root}/shared/${shareId}.json`, detail);
    } catch (error) { sharedFailures.push(shareId + ': ' + (error instanceof Error ? error.message : String(error))); }
  }
  const selected = inventory.conversations.slice(0, options.max);
  let completed = 0, skipped = 0, partial = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  let index = 0;
  progress.set('Capturing', 0, selected.length, 'checking local checkpoints');
  const worker = async (): Promise<void> => {
    while (!cancelled()) {
      const current = index++;
      const item = selected[current];
      if (!item) return;
      const conversationRoot = `${root}/conversations/${item.id}`;
      try {
        if (await archive.canSkip(workspace.key, item.id, item.updated, options.assets)) { skipped++; completed++; }
        else {
          const prior = await archive.marker(workspace.key, item.id);
          const reusable = prior?.updated === item.updated && await archive.verified(prior.raw);
          const source = reusable ? await archive.read<unknown>(prior.raw.path) : await readDetail(api, workspace, item.id);
          if (!source) throw new Error('Conversation detail is missing');
          const raw = reusable ? prior.raw : await archive.json(`${conversationRoot}/raw.json`, source);
          const assets = options.assets ? await saveAssets(api, archive, workspace, conversationRoot, source, { conversationId: item.id, existing: prior?.files })
            : { files: [], missing: [{ id: '*', reason: 'Assets intentionally disabled' }] };
          const marker: CompletionMarker = {
            schema: 1, id: item.id, updated: item.updated, raw, files: assets.files, missing: assets.missing, completedAt: new Date().toISOString(),
          };
          await archive.json(`${conversationRoot}/complete.json`, marker);
          await archive.journal(workspace.key, { event: 'conversation', id: item.id, status: assets.missing.length ? 'partial' : 'complete' });
          if (assets.missing.length) partial++;
          completed++;
        }
      } catch (error) {
        // An expired login must interrupt the archive, not generate thousands of
        // bogus per-conversation failures while the remaining queue drains.
        if (error instanceof RateLimitExhausted || (error instanceof ApiError && error.status === 401)) throw error;
        const reason = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
        failed.push({ id: item.id, reason });
        await archive.journal(workspace.key, { event: 'error', id: item.id, reason });
      }
      progress.set('Capturing', completed + failed.length, selected.length, `${skipped} previously saved; ${partial} partial; ${failed.length} errors`);
    }
  };
  const tasks = Array.from({ length: options.concurrency }, () => worker());
  try { await Promise.all(tasks); }
  catch (error) {
    api.cancel();
    await Promise.allSettled(tasks);
    await archive.json(`${root}/interrupted.json`, { at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), completed, failed });
    throw error;
  }
  const verification = await archive.verifyWorkspace(workspace.key);
  const report = {
    workspace: { label: workspace.label, key: workspace.key, kind: workspace.kind },
    inventoryGeneratedAt: inventory.generatedAt, discovered: inventory.conversations.length,
    selected: selected.length, completed, skipped, partial, failed,
    projectMissing, sharedFailures, account, inventoryWarnings: inventory.warnings, scopes: inventory.scopes, verification,
    status: cancelled() ? 'cancelled' : options.max !== undefined || !options.assets || failed.length || partial || projectMissing.length || sharedFailures.length || inventory.warnings.length || Object.values(account).some(v => v.startsWith('unavailable')) || verification.failed.length || verification.otherMissing.length ? 'partial' : 'complete',
    at: new Date().toISOString(),
  };
  await archive.json(`${root}/report.json`, report);
  progress.info(`${workspace.label}: ${report.status}. ${completed} processed, ${skipped} already saved, ${failed.length} errors, ${partial} missing asset sets.`);
  return report;
}


export interface ArchiveReport {
  schema: 1;
  at: string;
  output: string;
  status: 'complete' | 'partial' | 'cancelled';
  workspaces: unknown[];
  reports: Record<string, unknown>[];
}

export async function exportAll(api: ChatGptApi, options: ExportOptions, progress: Progress, cancelled: () => boolean): Promise<ArchiveReport> {
  const archive = new Archive(options.output);
  const workspaces = await discoverWorkspaces(api);
  progress.info(`Discovered ${workspaces.length} workspace(s): ${workspaces.map(w => w.label).join(', ')}`);
  const reports: Record<string, unknown>[] = [];
  for (const workspace of workspaces) {
    if (cancelled()) break;
    reports.push(await exportWorkspace(api, archive, workspace, progress, options, cancelled));
  }
  const report: ArchiveReport = {
    schema: 1, at: new Date().toISOString(), output: options.output,
    status: cancelled() ? 'cancelled' : reports.every(x => x.status === 'complete') && reports.length === workspaces.length ? 'complete' : 'partial',
    workspaces: reports.map(r => r.workspace), reports,
  };
  await archive.json('report.json', report);
  progress.info(`Archive ${report.status}: ${options.output}. Read report.json for coverage and missing data.`);
  return report;
}

export interface VerificationResult {
  key: string;
  expected: number;
  complete: number;
  partial: number;
  failed: string[];
  otherMissing: string[];
}

export async function verifyArchive(output: string): Promise<VerificationResult[]> {
  const archive = new Archive(output);
  const summary = await archive.read<{ workspaces?: Array<{ key: string }> }>('report.json');
  const keys = summary?.workspaces?.map(w => w.key)
    ?? (await readdir(archive.path('workspaces'), { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name);
  if (!keys.length) throw new Error('No workspace archives found. Export data first.');
  const results: VerificationResult[] = [];
  for (const key of keys) results.push({ key, ...(await archive.verifyWorkspace(key)) });
  return results;
}
