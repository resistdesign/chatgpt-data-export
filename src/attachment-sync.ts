import { Archive, safeId, type CompletionMarker, type SavedFile } from './archive.js';
import { AutomaticAssetRoutePolicy, saveAssets } from './assets.js';
import { discoverWorkspaces, type Inventory, type Workspace } from './discovery.js';
import { ExportCancelledError } from './errors.js';
import { missingAssetQueueStatus, scanMissingAssetTargets, type MissingAssetTarget } from './recovery.js';
import type { ChatGptApi } from './api-types.js';
import type { AttachmentSyncProgress, Progress } from './progress.js';

/**
 * The full attachment pass is driven entirely by locally saved file references.
 * It NEVER re-enumerates or re-downloads conversations.
 * A manual 10-file recovery operation remains available for previously denied
 * files. "Unavailable" is not a claim that ChatGPT can never restore the file.
 */
export interface AttachmentSyncResult {
  schema: 1;
  at: string;
  status: 'running' | 'finished' | 'stopped' | 'interrupted';
  totalMissing: number;
  eligible: number;
  processed: number;
  attempted: number;
  recovered: number;
  alreadyVerified: number;
  unavailable: number;
  unlisted: number;
  missingSource: number;
  previouslyUnavailable: number;
  unavailableWorkspace: number;
  remaining: number;
}

type SavedAssetIndex = {
  files: SavedFile[];
  missing: Array<{ id: string; reason: string; attempts?: unknown }>;
  names?: Array<{ id: string; name: string | null }>;
};

const indexFile = (root: string): string => `${root}/assets-index.json`;
const distinctFiles = (items: SavedFile[]): SavedFile[] =>
  [...new Map(items.map(item => [item.path, item])).values()];

function groupTargets(targets: MissingAssetTarget[]): Map<string, MissingAssetTarget[]> {
  const groups = new Map<string, MissingAssetTarget[]>();
  for (const target of targets) {
    const key = `${target.workspaceKey}/${target.kind}/${target.ownerId}`;
    const list = groups.get(key) ?? [];
    list.push(target);
    groups.set(key, list);
  }
  return groups;
}

export async function syncMissingAttachments(
  api: ChatGptApi, output: string, progress: Progress, cancelled: () => boolean,
): Promise<AttachmentSyncResult> {
  const archive = new Archive(output);
  const initial = await scanMissingAssetTargets(output);
  if (!initial.overview) throw new Error('No local archive inventory found. Back up conversations first.');
  const summary: AttachmentSyncResult = {
    schema: 1, at: new Date().toISOString(), status: 'running',
    totalMissing: initial.overview.missingFiles,
    eligible: 0, processed: 0, attempted: 0, recovered: 0,
    alreadyVerified: 0, unavailable: 0, unlisted: 0,
    missingSource: 0, previouslyUnavailable: 0, unavailableWorkspace: 0,
    remaining: initial.overview.missingFiles,
  };
  const persist = async (): Promise<void> => {
    summary.at = new Date().toISOString();
    await archive.json('attachment-sync-latest.json', summary);
  };
  if (!initial.targets.length) {
    summary.status = 'finished';
    progress.set('Syncing attachments', 0, 0, 'No missing attachment references in the local archive');
    await persist();
    return summary;
  }

  // Authentication is checked once before doing any file requests. No
  // conversation listing or detail request is issued by this engine.
  const workspaces = await discoverWorkspaces(api);
  const available = new Map(workspaces.map(workspace => [workspace.key, workspace]));
  const queue: MissingAssetTarget[] = [];
  for (const target of initial.targets) {
    if (!available.has(target.workspaceKey)) summary.unavailableWorkspace++;
    else if (missingAssetQueueStatus(target.reason) === 'unavailable') summary.previouslyUnavailable++;
    else queue.push(target);
  }
  // Chat attachment recovery first. Previously denied Project files do not
  // consume hours of retries ahead of recoverable conversation attachments.
  queue.sort((left, right) => Number(left.kind === 'project') - Number(right.kind === 'project'));
  summary.eligible = queue.length;
  // One policy learns from all files in this pass. It never records private IDs.
  const routePolicy = new AutomaticAssetRoutePolicy();
  const MAX_CONSECUTIVE_DENIALS = 60;
  let consecutiveDenials = 0;
  const inventories = new Map<string, Inventory | undefined>();
  const inventoryFor = async (key: string): Promise<Inventory | undefined> => {
    if (!inventories.has(key)) {
      inventories.set(key, await archive.read<Inventory>(`workspaces/${safeId(key)}/inventory.json`));
    }
    return inventories.get(key);
  };
  const metrics = (): AttachmentSyncProgress => ({
    eligible: summary.eligible,
    attempted: summary.attempted,
    recovered: summary.recovered,
    alreadyVerified: summary.alreadyVerified,
    unavailable: summary.unavailable,
    unlisted: summary.unlisted,
    missingSource: summary.missingSource,
    previouslyUnavailable: summary.previouslyUnavailable,
  });
  const update = (note: string): void => {
    progress.set('Syncing attachments', summary.processed, summary.eligible, note, undefined, metrics());
  };
  const done = async (workspace: Workspace, result: string): Promise<void> => {
    summary.processed++;
    summary.remaining = Math.max(0, summary.totalMissing - summary.recovered);
    update(`${summary.recovered} recovered; ${summary.unavailable} newly unavailable; ${summary.previouslyUnavailable} previously unavailable`);
    if (summary.processed % 25 === 0 || summary.processed === summary.eligible) {
      await persist();
      progress.info(`Attachments: ${summary.processed}/${summary.eligible} processed; ${summary.recovered} recovered; ${summary.unavailable} unavailable; ${summary.unlisted} unlisted; ${summary.previouslyUnavailable} previously unavailable (skipped).`);
      await archive.journal(workspace.key, {
        event: 'attachment-sync-checkpoint', processed: summary.processed,
        recovered: summary.recovered, unavailable: summary.unavailable,
        skipped: summary.previouslyUnavailable, status: result,
      });
    }
  };
  update(`Using saved file references only; ${summary.previouslyUnavailable} previously denied attachments skipped`);
  await persist();

  try {
    groups: for (const targets of groupTargets(queue).values()) {
      if (cancelled()) throw new ExportCancelledError();
      const first = targets[0]!;
      const workspace = available.get(first.workspaceKey)!;
      const scope = `workspaces/${safeId(workspace.key)}`;
      const root = `${scope}/${first.kind === 'project' ? 'projects' : 'conversations'}/${safeId(first.ownerId)}`;
      const inventory = await inventoryFor(workspace.key);
      const marker = first.kind === 'conversation'
        ? await archive.marker(workspace.key, first.ownerId) : undefined;
      const sourceValid = first.kind === 'project'
        ? Boolean(inventory?.projects.some(project => project.id === first.ownerId))
        : Boolean(marker?.raw && await archive.verified(marker.raw));
      const project = first.kind === 'project'
        ? inventory?.projects.find(item => item.id === first.ownerId) : undefined;
      const source = first.kind === 'conversation' && sourceValid && marker
        ? await archive.read<unknown>(marker.raw.path)
        : project ? (project.details ?? project.raw) : undefined;
      const conversationProject = first.kind === 'conversation'
        ? inventory?.conversations.find(chat => chat.id === first.ownerId)?.projectId
        : undefined;
      let indexed = await archive.read<SavedAssetIndex>(indexFile(root));
      const originalManifest = first.kind === 'project'
        ? await archive.read<{ files?: SavedFile[] }>(`${root}/manifest.json`)
        : undefined;
      let files: SavedFile[] = distinctFiles([
        ...(marker?.files ?? []), ...(indexed?.files ?? []),
        ...(originalManifest?.files ?? []).filter(file => file.path.startsWith(`${root}/assets/`)),
      ]);
      let missing = (first.kind === 'conversation' ? marker?.missing : indexed?.missing) ?? [];

      for (const target of targets) {
        if (cancelled()) throw new ExportCancelledError();
        const wantedPath = `${root}/assets/${safeId(target.fileId)}`;
        const previous = files.find(file => file.path === wantedPath);
        const verified = Boolean(previous && await archive.verified(previous));
        // A crash might have committed an asset index but not its conversation
        // marker/Project manifest. Reconcile it locally without downloading.
        if (verified) {
          files = distinctFiles(files);
          missing = missing.filter(entry => entry.id !== target.fileId);
          summary.recovered++;
          summary.alreadyVerified++;
          consecutiveDenials = 0;
        } else if (!sourceValid || source === undefined) {
          summary.missingSource++;
          await done(workspace, 'missing-source');
          continue;
        } else {
          const ids = new Set([target.fileId]);
          const asset = await saveAssets(api, archive, workspace, root, source, {
            ...(first.kind === 'project'
              ? { projectId: first.ownerId, projectFiles: project?.files ?? [] }
              : { conversationId: first.ownerId, projectId: conversationProject }),
            existing: files, existingMissing: missing,
            existingNames: indexed?.names, onlyIds: ids, routePolicy,
            onProgress: updateProgress => update(
              `File ${summary.processed + 1}/${summary.eligible}: ${updateProgress.method}`),
          });
          files = distinctFiles(asset.files);
          missing = asset.missing;
          if (asset.unlisted) {
            // Avoid repeating an unmatched old ID on every future sync. It is
            // still available to the explicit manual retry action.
            missing = missing.map(entry => entry.id === target.fileId
              ? { ...entry, reason: 'Absent from saved source metadata' } : entry);
            summary.unlisted++;
          } else if (!missing.some(entry => entry.id === target.fileId)) {
            summary.recovered++;
            consecutiveDenials = 0;
          } else {
            summary.unavailable++;
            consecutiveDenials++;
          }
          summary.attempted += asset.attempted;
        }

        // Per-attachment durable checkpoint, not one giant transaction. A
        // crash loses at most the current file request, not prior recoveries.
        const savedIndex = await archive.read<SavedAssetIndex>(indexFile(root));
        indexed = { files, missing, names: savedIndex?.names ?? indexed?.names };
        await archive.json(indexFile(root), indexed);
        if (first.kind === 'conversation' && marker) {
          await archive.json(`${root}/complete.json`, {
            ...marker, files, missing, completedAt: new Date().toISOString(),
          } satisfies CompletionMarker);
        } else if (first.kind === 'project') {
          const manifestFile = `${root}/manifest.json`;
          let manifest = await archive.read<{ files?: SavedFile[] }>(manifestFile);
          if (!manifest?.files?.length && project) {
            const info = await archive.json(`${root}/info.json`, project.details ?? project.raw);
            manifest = { files: [info] };
          }
          const metadata = (manifest?.files ?? []).filter(file => !file.path.startsWith(`${root}/assets/`));
          // A previous interrupted pass may have registered a verified asset
          // in the Project manifest before its index changed. Never drop it.
          const previouslyListed = (manifest?.files ?? []).filter(file => file.path.startsWith(`${root}/assets/`));
          await archive.json(manifestFile, {
            files: [...metadata, ...distinctFiles([...previouslyListed, ...files])],
          });
        }
        await done(workspace, verified ? 'verified' : 'attempted');
        if (consecutiveDenials >= MAX_CONSECUTIVE_DENIALS) {
          // Do not hammer thousands of evidently inaccessible historical files.
          // All untouched records remain deferred for a later/manual recovery.
          summary.status = 'stopped';
          progress.info(`Automatic attachment sync paused after ${consecutiveDenials} consecutive unavailable files. Saved files remain intact; remaining deferred references are untouched.`);
          break groups;
        }
      }
    }
    if (summary.status === 'running') summary.status = 'finished';
  } catch (error) {
    summary.status = cancelled() || error instanceof ExportCancelledError ? 'stopped' : 'interrupted';
    throw error;
  } finally {
    // The ground truth is in the files and per-conversation markers, not this
    // summary. Recompute final backlog after an interruption as well.
    const finalScan = await scanMissingAssetTargets(output);
    summary.remaining = finalScan.overview?.missingFiles ?? summary.remaining;
    await persist();
    update(summary.status === 'finished'
      ? `Pass finished: ${summary.recovered} recovered; ${summary.remaining} references still missing`
      : `Pass ${summary.status}; saved checkpoints retained`);
  }
  return summary;
}
