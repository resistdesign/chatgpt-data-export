import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, workspaceKey, type CompletionMarker } from './archive.js';
import { archiveDiagnosticText, inspectArchive, findMissingProjectExample, missingProjectFilePairs, recoverMissingAssets } from './recovery.js';
import { Progress } from './progress.js';
import type { Inventory } from './discovery.js';
import type { ChatGptApi } from './api-types.js';

const id = 'account_test';
const key = workspaceKey(id);
const root = `workspaces/${key}`;
const project = 'g-p-test';
const conversation = 'chat_one';

async function fixture(dir: string): Promise<{ archive: Archive; raw: { path: string; sha256: string; bytes: number } }> {
  const archive = new Archive(dir);
  const inventory: Inventory = {
    schema: 1, generatedAt: new Date().toISOString(),
    conversations: [{ id: conversation, title: 'Sample', updated: 1 }],
    projects: [{
      id: project, raw: {}, files: [{ file_id: 'file_project_asset', name: 'document.txt' }],
    }],
    shared: [], warnings: [],
    scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
  };
  await archive.json(`${root}/inventory.json`, inventory);
  const existing = await archive.atomic(`${root}/conversations/${conversation}/assets/file_existing_asset`, 'already saved');
  const raw = await archive.json(`${root}/conversations/${conversation}/raw.json`, {
    id: conversation,
    messages: [{
      id: 'message_one',
      content: { parts: [
        { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_existing_asset' },
        { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_image_asset' },
      ] },
    }],
  });
  const marker: CompletionMarker = {
    schema: 1, id: conversation, updated: 1, raw, files: [existing],
    missing: [{ id: 'file_image_asset', reason: 'permission_error' }],
    completedAt: new Date().toISOString(),
  };
  await archive.json(`${root}/conversations/${conversation}/complete.json`, marker);
  const info = await archive.json(`${root}/projects/${project}/info.json`, { name: 'Project' });
  await archive.json(`${root}/projects/${project}/manifest.json`, { files: [info] });
  await archive.json(`${root}/projects/${project}/assets-index.json`, {
    files: [], names: [{ id: 'file_project_asset', name: 'document.txt' }],
    missing: [{ id: 'file_project_asset', reason: 'permission_error' }],
  });
  return { archive, raw };
}

test('startup archive inspection is offline, checkpoint-based and honest about verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-overview-'));
  try {
    assert.equal(await inspectArchive(dir), null);
    await fixture(dir);
    const overview = await inspectArchive(dir);
    assert.deepEqual({
      discovered: overview?.discovered, complete: overview?.recordedComplete,
      partial: overview?.recordedPartial, missing: overview?.missingFiles,
      projectMissing: overview?.projectsWithMissing, unattempted: overview?.notYetCaptured,
      verified: overview?.verified,
      blockers: overview?.blockers,
    }, { discovered: 1, complete: 0, partial: 1, missing: 2,
      projectMissing: 1, unattempted: 0, verified: false,
      blockers: { permission_error: 2, 'HTTP 401': 0, 'HTTP 403': 0, 'HTTP 404': 0, other: 0 },
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('targeted recovery preserves valid assets, updates both markers, and does not re-inventory ChatGPT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-target-recovery-'));
  try {
    const { archive, raw } = await fixture(dir);
    const paths: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        paths.push(path);
        if (path === '/backend-api/accounts/check/v4-2023-04-27') {
          return { accounts: { [id]: { account: { account_id: id, account_name: 'Test' } } } };
        }
        if (path.startsWith('/backend-api/files/download/')) {
          return { status: 'error', error_code: 'permission_error' };
        }
        throw new Error(`Unexpected API route ${path}`);
      },
      openFile: async path => {
        paths.push(path);
        assert.match(path, /^\/backend-api\/files\/(?:download\/file_(?:image|project)_asset|file_(?:image|project)_asset\/download)/);
        return new Response('recovered file bytes', {
          status: 200, headers: { 'content-type': 'application/octet-stream' },
        });
      },
    };
    const progress = new Progress(undefined, false);
    const recovered = await recoverMissingAssets(api, dir, progress, () => false, 2);
    assert.deepEqual(recovered, {
      selected: 2, attempted: 2, unlisted: 0, recovered: 2, stillMissing: 0, remainingInArchive: 0,
    });
    assert.equal(paths.filter(path => path.startsWith('/backend-api/accounts/check')).length, 1);
    assert.ok(paths.every(path => path.startsWith('/backend-api/accounts/check') ||
      path.startsWith('/backend-api/files/')), 'must not query conversation or Project listing APIs');
    const marker = await archive.marker(key, conversation);
    assert.equal(marker?.missing.length, 0);
    assert.equal(marker?.files.length, 2, 'previously downloaded file remains in marker');
    assert.equal(marker?.raw.sha256, raw.sha256, 'raw conversation is not downloaded or rewritten');
    assert.ok(await archive.verified(marker!.files[0]!));
    assert.ok(await archive.verified(marker!.files[1]!));
    const projectIndex = await archive.read<{ files: Array<{ path: string }>; missing: unknown[] }>(
      `${root}/projects/${project}/assets-index.json`);
    assert.equal(projectIndex?.files.length, 1);
    assert.equal(projectIndex?.missing.length, 0);
    const projectManifest = await archive.read<{ files: Array<{ path: string }> }>(
      `${root}/projects/${project}/manifest.json`);
    assert.equal(projectManifest?.files.length, 2, 'Project info and newly recovered asset remain');
    const overview = await inspectArchive(dir);
    assert.equal(overview?.recordedComplete, 1);
    assert.equal(overview?.missingFiles, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bounded recovery does not touch more missing files than selected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-bounded-recovery-'));
  try {
    const { archive } = await fixture(dir);
    const paths: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        paths.push(path);
        if (path.includes('accounts/check')) {
          return { accounts: { [id]: { account: { account_id: id } } } };
        }
        return { status: 'error', error_code: 'permission_error' };
      },
      openFile: async path => {
        paths.push(path);
        return new Response('new bytes', {
          status: 200, headers: { 'content-type': 'application/octet-stream' },
        });
      },
    };
    const first = await recoverMissingAssets(api, dir, new Progress(undefined, false), () => false, 1);
    assert.equal(first.selected, 1);
    assert.equal(first.attempted, 1);
    assert.equal(first.unlisted, 0);
    assert.equal(first.recovered, 1);
    assert.equal(first.remainingInArchive, 1);
    const p = await archive.read<{ missing: unknown[] }>(`${root}/projects/${project}/assets-index.json`);
    assert.equal(p?.missing.length, 0, 'Project file is processed first when a one-file batch is requested');
    const marker = await archive.marker(key, conversation);
    assert.equal(marker?.missing.length, 1, 'conversation assets remain for later recovery passes');
    assert.ok(paths.every(path => !path.includes('file_image_asset')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sanitized diagnostics aggregate route failures without exposing source IDs, server messages, or paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-safe-diag-'));
  try {
    const { archive } = await fixture(dir);
    const path = `${root}/projects/${project}/assets-index.json`;
    const index = await archive.read<{
      files: unknown[]; names: unknown[];
      missing: Array<{ id: string; reason: string; attempts?: unknown[] }>;
    }>(path);
    assert.ok(index);
    index.missing[0]!.attempts = [
      { route: 'project-signed', workspaceHeader: true, reason: 'HTTP 403 Bearer PRIVATE-TOKEN /users/alice/client.txt' },
      { route: 'project-direct', workspaceHeader: false, reason: 'HTTP 404 /users/alice/client.txt' },
      { route: 'https://private.example.com/secret', workspaceHeader: false,
        reason: 'permission_error for file_project_asset' },
    ];
    await archive.json(path, index);
    const overview = await inspectArchive(dir);
    assert.ok(overview?.routeFailures.some(item =>
      item.route === 'project-signed' && item.result === 'HTTP 403' && item.attempts === 1));
    const summary = await archiveDiagnosticText(dir);
    assert.match(summary, /project-signed \/ workspace header: HTTP 403 x1/);
    assert.match(summary, /unrecognized route \/ default scope: permission_error x1/);
    assert.doesNotMatch(summary, /PRIVATE-TOKEN|client\.txt|file_project_asset|private\.example\.com|\/users\/alice/);
    assert.match(summary, /not unique files/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing ID absent from Project metadata does not count as an attempted download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-unmatched-files-'));
  try {
    const { archive } = await fixture(dir);
    const indexPath = `${root}/projects/${project}/assets-index.json`;
    const indexBefore = await archive.read<{ files: unknown[]; names: unknown[]; missing: Array<{ id: string; reason: string }> }>(indexPath);
    assert.ok(indexBefore);
    // Old capture index contains file_project_asset, but current saved Project
    // listing references an unrelated identifier. This must not count as a download.
    const inventory = await archive.read<Inventory>(`${root}/inventory.json`);
    assert.ok(inventory);
    inventory.projects[0]!.files = [{ file_id: 'file_replacement_asset', name: 'new.txt' }];
    await archive.json(`${root}/inventory.json`, inventory);
    const beforeHash = await archive.fileHash(indexPath);
    const requests: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        requests.push(path);
        if (path.includes('accounts/check')) {
          return { accounts: { [id]: { account: { account_id: id } } } };
        }
        throw new Error('No download request should be issued');
      },
      openFile: async path => { requests.push(path); throw new Error('No file request expected'); },
    };
    const result = await recoverMissingAssets(api, dir, new Progress(undefined, false), () => false, 1);
    assert.deepEqual(result, {
      selected: 1, attempted: 0, unlisted: 1, recovered: 0,
      stillMissing: 1, remainingInArchive: 2,
    });
    assert.equal(await archive.fileHash(indexPath), beforeHash, 'untouched index remains byte-for-byte unchanged');
    assert.equal(requests.length, 1, 'only a workspace authentication check is issued');
    const diagnostic = await archiveDiagnosticText(dir);
    assert.match(diagnostic, /1 selected, 0 attempted, 1 absent from saved source metadata/);
    assert.doesNotMatch(diagnostic, /file_project_asset|file_replacement_asset/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('offline selector identifies an actual missing Project file without copying IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-exact-compare-'));
  try {
    await fixture(dir);
    const target = await findMissingProjectExample(dir);
    assert.deepEqual(target, {
      projectId: project, projectName: 'Project with missing file',
      fileName: 'document.txt',
    });
    const pairs = await missingProjectFilePairs(dir);
    assert.equal(pairs.has(project + '\0' + 'file_project_asset'), true);
    assert.equal(pairs.has(project + '\0' + 'file_other_asset'), false);
    const summary = await archiveDiagnosticText(dir);
    assert.doesNotMatch(summary, /document\.txt|g-p-test|file_project_asset/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
