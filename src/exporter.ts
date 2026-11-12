import { readdir } from 'node:fs/promises';
import { Archive, sha256, type CompletionMarker, type SavedFile } from './archive.js';
import { ApiError, RateLimitExhausted, SessionExpiredError, SessionCheckError, ExportCancelledError } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import { saveAssets, deferAssets } from './assets.js';
import { buildInventory, refreshRecentInventory, discoverWorkspaces, readDetail, record, array, str, type Inventory, type Workspace, type IncrementalInventoryResult } from './discovery.js';
import type { Progress } from './progress.js';

export interface ExportOptions {
  output: string;
  concurrency: number;
  max: number | undefined;
  assets: boolean;
  refresh: boolean;
  /** Fresh listings, capture only new/changed chats, skip old Project/account downloads. */
  sync?: boolean;
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
      if (error instanceof ApiError && !(error instanceof SessionExpiredError) && [401, 403, 404, 405].includes(error.status)) result[name] = `unavailable (HTTP ${error.status})`;
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
    if (error instanceof ApiError && !(error instanceof SessionExpiredError) && [401, 403, 404, 405].includes(error.status)) result.custom_gpts = `unavailable (HTTP ${error.status})`;
    else throw error;
  }
  await archive.json(`${root}/account/status.json`, result);
  await archive.json(`${root}/account/manifest.json`, { files: savedFiles });
  return result;
}

const PILOT_PROJECT_LIMIT = 3;

/** A pilot checks a bounded, representative set of Projects; full exports scan all. */
function projectsForRun(
  inventory: Inventory,
  conversations: Inventory['conversations'],
  pilot: boolean,
): Inventory['projects'] {
  if (!pilot) return inventory.projects;
  const referenced = new Set(conversations.map(chat => chat.projectId).filter((id): id is string => Boolean(id)));
  return inventory.projects
    .map((project, index) => ({
      project, index,
      score: (project.files.length > 0 ? 2 : 0) + (referenced.has(project.id) ? 1 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, PILOT_PROJECT_LIMIT)
    .map(item => item.project);
}

export async function exportWorkspace(api: ChatGptApi, archive: Archive, workspace: Workspace, progress: Progress, options: ExportOptions, cancelled: () => boolean): Promise<Record<string, unknown>> {
  const root = `workspaces/${workspace.key}`;
  const previous = options.refresh && !options.sync
    ? undefined : await archive.read<Inventory>(`${root}/inventory.json`);
  const canReuse = previous?.schema === 1 &&
    previous.scopes.main === 'complete' && previous.scopes.archived === 'complete';
  const delta: IncrementalInventoryResult | null = options.sync && canReuse
    ? await refreshRecentInventory(api, workspace, previous, progress) : null;
  const inventory = delta?.inventory ?? (canReuse ? previous : await buildInventory(api, workspace, progress));
  if (inventory !== previous) await archive.json(`${root}/inventory.json`, inventory);
  progress.info(`Workspace ${workspace.label}: ${inventory.conversations.length} conversations, ${inventory.projects.length} Projects. Inventory ${delta ? 'incrementally updated' : previous === inventory ? 'resumed' : 'saved'}.`);
  if (!options.assets) progress.info('History-first export: saving conversation JSON and Project metadata now; attachment downloads are deferred.');
  const account = delta
    ? await archive.read<Record<string, string>>(`${root}/account/status.json`) ?? {}
    : await captureAccount(api, archive, workspace, progress);
  const changedIds = new Set(delta?.changedIds ?? []);
  const selected = delta
    ? inventory.conversations.filter(item => changedIds.has(item.id))
    : inventory.conversations.slice(0, options.max);
  const pilot = options.max !== undefined;
  const projectTargets = delta
    ? inventory.projects.filter(item => delta.newProjectIds.includes(item.id))
    : projectsForRun(inventory, selected, pilot);
  if (delta) progress.info(`Quick sync: ${delta.newIds.length} new and ${delta.changedIds.length - delta.newIds.length} updated conversations need capture; existing checkpoints stay untouched.`);
  const projectMissing: string[] = [];
  const sharedFailures: string[] = [];
  if (pilot) {
    progress.info(`Pilot: checking ${projectTargets.length}/${inventory.projects.length} representative Projects. A full export checks every Project.`);
  }
  progress.set(options.assets ? 'Saving Project files' : 'Saving Project metadata', 0, projectTargets.length,
    options.assets ? 'Checking Project attachments' : 'Saving Project metadata without downloading attachments');
  for (const [index, project] of projectTargets.entries()) {
    const projectRoot = `${root}/projects/${project.id}`;
    const info = await archive.json(`${projectRoot}/info.json`, project.details ?? project.raw);
    const previousAssets = await archive.read<{
      files: SavedFile[];
      missing: Array<{ id: string; reason: string }>;
      names?: Array<{ id: string; name: string | null }>;
    }>(`${projectRoot}/assets-index.json`);
    const assets = options.assets
      ? await saveAssets(api, archive, workspace, projectRoot, project.details ?? project.raw, {
        projectId: project.id, projectFiles: project.files, existing: previousAssets?.files,
        onProgress: asset => progress.set('Saving Project files', index, projectTargets.length,
          `Project ${index + 1}/${projectTargets.length}: file ${asset.current}/${asset.total} · ${asset.method}`),
      })
      : await deferAssets(archive, projectRoot, project.details ?? project.raw, {
        projectFiles: project.files, existing: previousAssets?.files,
        existingMissing: previousAssets?.missing, existingNames: previousAssets?.names,
      });
    const projectFiles = assets.files;
    if (assets.missing.length) projectMissing.push(project.id);
    await archive.json(`${projectRoot}/manifest.json`, { files: [info, ...projectFiles] });
    progress.set(options.assets ? 'Saving Project files' : 'Saving Project metadata', index + 1, projectTargets.length,
      `${index + 1} Projects checked; ${projectMissing.length} deferred or missing asset sets`);
    // A long list of attachment fallbacks can take several minutes. Never
    // leave the Activity log silent for ten entire Projects.
    if ((index + 1) % 5 === 0 || index + 1 === projectTargets.length) {
      progress.info(`Projects: ${index + 1}/${projectTargets.length} metadata saved; ${projectMissing.length} have deferred or missing attachments.`);
    }
  }
  // Shared-only links may not have an owner conversation ID. Keep their raw listing
  // and attempt to capture the share itself without pretending it's a normal chat.
  const sharedTargets = delta
    ? inventory.shared.filter(item => delta.newShareIds.includes(
      str(record(item).id) ?? str(record(item).share_id) ?? JSON.stringify(item)))
    : inventory.shared;
  for (const share of sharedTargets) {
    const entry = record(share);
    if (str(entry.conversation_id)) continue;
    const shareId = str(entry.id) ?? str(entry.share_id);
    if (!shareId || !/^[A-Za-z0-9_-]{1,256}$/.test(shareId)) { sharedFailures.push('unknown share identifier'); continue; }
    try {
      const detail = await api.get(`/backend-api/share/${shareId}`, workspace.id);
      await archive.json(`${root}/shared/${shareId}.json`, detail);
    } catch (error) {
      if (error instanceof ExportCancelledError || error instanceof SessionExpiredError ||
        error instanceof SessionCheckError || error instanceof RateLimitExhausted) throw error;
      sharedFailures.push(shareId + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  let completed = 0, skipped = 0, partial = 0;
  const failed: Array<{ id: string; reason: string }> = [];
  let index = 0;
  let stoppingForFatalError = false;
  const captureProgress = (detail = 'Checking saved checkpoints and downloading conversations'): void => {
    const attempted = completed + failed.length;
    const complete = completed - partial;
    const active = Math.max(0, Math.min(index, selected.length) - attempted);
    progress.set('Capturing', attempted, selected.length, detail, {
      attempted, complete, partial, failed: failed.length, reused: skipped, active,
    });
  };
  captureProgress();
  const worker = async (): Promise<void> => {
    while (!cancelled() && !stoppingForFatalError) {
      const current = index++;
      const item = selected[current];
      if (!item) return;
      captureProgress(`Checking conversation ${current + 1}/${selected.length} and its saved checkpoint`);
      const conversationRoot = `${root}/conversations/${item.id}`;
      try {
        if (!delta && await archive.canSkip(workspace.key, item.id, item.updated, options.assets)) {
          const priorMarker = await archive.marker(workspace.key, item.id);
          skipped++;
          completed++;
          // A reusable RAW checkpoint can still have missing attachments.
          // It must not be counted as fully saved during history-first runs.
          if (priorMarker?.missing.length) partial++;
        } else {
          const prior = await archive.marker(workspace.key, item.id);
          const reusable = !delta && prior?.updated === item.updated && await archive.verified(prior.raw);
          const source = reusable ? await archive.read<unknown>(prior.raw.path) : await readDetail(api, workspace, item.id);
          if (!source) throw new Error('Conversation detail is missing');
          // On incremental updates, NEVER overwrite the prior raw record.
          // Keep both its bytes and previous completion metadata, then atomically
          // point the new checkpoint at a content-addressed revision.
          const preserved = Boolean(delta && prior && await archive.verified(prior.raw));
          if (preserved && prior) {
            await archive.json(`${conversationRoot}/revisions/${prior.raw.sha256}.marker.json`, prior);
          }
          const rawPath = preserved
            ? `${conversationRoot}/revisions/${sha256(JSON.stringify(source))}.json`
            : `${conversationRoot}/raw.json`;
          const raw = reusable ? prior.raw : await archive.json(rawPath, source);
          const assets = options.assets
            ? await saveAssets(api, archive, workspace, conversationRoot, source, {
              conversationId: item.id, projectId: item.projectId, existing: prior?.files,
              onProgress: asset => captureProgress(
                `Conversation ${current + 1}/${selected.length}: file ${asset.current}/${asset.total} · ${asset.method}`),
            })
            : await deferAssets(archive, conversationRoot, source, {
              existing: prior?.files, existingMissing: prior?.missing,
              existingNames: (await archive.read<{ names?: Array<{ id: string; name: string | null }> }>(
                `${conversationRoot}/assets-index.json`,
              ))?.names,
            });
          const marker: CompletionMarker = {
            schema: 1, id: item.id, updated: item.updated, raw, files: assets.files, missing: assets.missing, completedAt: new Date().toISOString(),
          };
          await archive.json(`${conversationRoot}/complete.json`, marker);
          await archive.journal(workspace.key, { event: 'conversation', id: item.id, status: assets.missing.length ? 'partial' : 'complete' });
          if (assets.missing.length) partial++;
          completed++;
        }
      } catch (error) {
        // An abandoned request is NOT a failed conversation. When a fatal
        // error or user cancellation stops the queue, suppress cancellation
        // fallout from the other in-flight workers.
        if (error instanceof ExportCancelledError) {
          if (!cancelled() && !stoppingForFatalError) {
            stoppingForFatalError = true;
            throw error;
          }
        } else if (error instanceof RateLimitExhausted || error instanceof SessionExpiredError ||
          error instanceof SessionCheckError) {
          stoppingForFatalError = true;
          throw error;
        } else if (!cancelled() && !stoppingForFatalError) {
          const reason = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
          failed.push({ id: item.id, reason });
          await archive.journal(workspace.key, {
            event: 'error', id: item.id, reason,
            ...(error instanceof ApiError ? { httpStatus: error.status, endpoint: error.endpoint } : {}),
          });
          if (failed.length <= 10 || failed.length % 25 === 0) {
            const kind = error instanceof ApiError ? `HTTP ${error.status}` : reason.slice(0, 80);
            progress.info(`Conversation attempt ${current + 1}/${selected.length} failed (${kind}); ${failed.length} total errors. See journal.jsonl for details.`);
          }
        }
      }
      // The bar tracks finished attempts. The separate counters distinguish
      // fully saved, partial, reused, and failed conversations.
      if (!cancelled() && !stoppingForFatalError) {
        captureProgress();
        const attempted = completed + failed.length;
        const every = selected.length <= 50 ? 5 : 25;
        if (attempted > 0 && (attempted === 1 || attempted % every === 0 || attempted === selected.length)) {
          progress.info(`Conversations: ${attempted}/${selected.length} processed; ${completed - partial} fully saved (${skipped} reused), ${partial} partial, ${failed.length} failed.`);
        }
      }
    }
  };
  const tasks = Array.from({ length: options.concurrency }, () => worker());
  try { await Promise.all(tasks); }
  catch (error) {
    api.cancel();
    await Promise.allSettled(tasks);
    await archive.json(`${root}/interrupted.json`, {
      at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
      cause: {
        name: error instanceof Error ? error.name : 'UnknownError',
        ...(error instanceof ApiError ? { httpStatus: error.status, endpoint: error.endpoint } : {}),
        ...(error instanceof RateLimitExhausted ? { endpoint: error.endpoint } : {}),
        ...(error instanceof SessionCheckError ? { httpStatus: error.status } : {}),
      },
      completed, partial, skipped, attempted: completed + failed.length, failed,
    });
    progress.info(`Export interrupted by ${error instanceof Error ? error.name : 'error'}: ${completed - partial} complete, ${partial} partial, ${failed.length} real failed attempts. See interrupted.json for the original cause.`);
    throw error;
  }
  progress.set('Verifying saved archive', 0, inventory.conversations.length, 'Checking local completion markers and file hashes');
  const verification = await archive.verifyWorkspace(workspace.key, (done, total) => {
    progress.set('Verifying saved archive', done, total, 'Hashing saved conversation data; no network access');
  });
  const report = {
    workspace: { label: workspace.label, key: workspace.key, kind: workspace.kind },
    inventoryGeneratedAt: inventory.generatedAt, discovered: inventory.conversations.length,
    ...(delta ? { incrementalSync: {
      new: delta.newIds.length,
      updated: delta.changedIds.length - delta.newIds.length,
      listingRequests: delta.requests,
      selected: selected.length,
      updatedAt: inventory.generatedAt,
    } } : {}),
    selected: selected.length, completed, skipped, partial, failed,
    projectCoverage: { total: inventory.projects.length, checked: projectTargets.length, sampled: pilot },
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
