import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, workspaceKey, type CompletionMarker } from './archive.js';
import { inspectArchive, recoverMissingAssets } from './recovery.js';
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
    }, { discovered: 1, complete: 0, partial: 1, missing: 2,
      projectMissing: 1, unattempted: 0, verified: false });
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
        assert.match(path, /\/backend-api\/files\/file_(image|project)_asset\/download/);
        return new Response('recovered file bytes', {
          status: 200, headers: { 'content-type': 'application/octet-stream' },
        });
      },
    };
    const progress = new Progress(undefined, false);
    const recovered = await recoverMissingAssets(api, dir, progress, () => false, 2);
    assert.deepEqual(recovered, {
      selected: 2, recovered: 2, stillMissing: 0, remainingInArchive: 0,
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
    assert.equal(first.recovered, 1);
    assert.equal(first.remainingInArchive, 1);
    const p = await archive.read<{ missing: unknown[] }>(`${root}/projects/${project}/assets-index.json`);
    assert.equal(p?.missing.length, 1, 'Project file was not processed in the first one-file batch');
    assert.ok(paths.every(path => !path.includes('file_project_asset')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
