import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, workspaceKey, type CompletionMarker } from './archive.js';
import { syncMissingAttachments } from './attachment-sync.js';
import { ApiError, RateLimitExhausted, ExportCancelledError } from './errors.js';
import { Progress, type ProgressSnapshot } from './progress.js';
import { inspectArchive } from './recovery.js';
import type { ChatGptApi } from './api-types.js';
import type { Inventory } from './discovery.js';

const account = 'account_test';
const key = workspaceKey(account);
const root = `workspaces/${key}`;
const conversation = 'chat_one';
const project = 'g-p-one';
const binary = (value: string): Response =>
  new Response(value, { status: 200, headers: { 'content-type': 'application/octet-stream' } });

async function fixture(dir: string): Promise<Archive> {
  const archive = new Archive(dir);
  const inventory: Inventory = {
    schema: 1, generatedAt: '2026-11-12T00:00:00Z',
    conversations: [{ id: conversation, title: 'Saved history', updated: 1 }],
    projects: [{
      id: project, raw: { gizmo: { name: 'Test Project' } },
      files: [
        { file_id: 'file_project_new', name: 'fresh.txt' },
        { file_id: 'file_project_denied', name: 'broken.txt' },
      ],
    }],
    shared: [], warnings: [],
    scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
  };
  await archive.json(`${root}/inventory.json`, inventory);
  const raw = await archive.json(`${root}/conversations/${conversation}/raw.json`, {
    id: conversation,
    messages: [{ id: 'm1', content: { parts: [
      { file_id: 'file_new_good' },
      { file_id: 'file_new_denied' },
      { file_id: 'file_old_denied' },
      { file_id: 'file_already_saved' },
    ] } }],
  });
  const reused = await archive.atomic(
    `${root}/conversations/${conversation}/assets/file_already_saved`, 'old bytes');
  const missing = [
    { id: 'file_new_good', reason: 'Download deferred to later file recovery' },
    { id: 'file_new_denied', reason: 'Download deferred to later file recovery' },
    { id: 'file_old_denied', reason: 'No accessible download after 6 attempts; HTTP 403' },
    { id: 'file_already_saved', reason: 'Download deferred to later file recovery' },
  ];
  const marker: CompletionMarker = {
    schema: 1, id: conversation, updated: 1, raw, files: [], missing,
    completedAt: '2026-11-12T00:00:00Z',
  };
  await archive.json(`${root}/conversations/${conversation}/complete.json`, marker);
  await archive.json(`${root}/conversations/${conversation}/assets-index.json`, {
    files: [reused], missing, names: missing.map(item => ({ id: item.id, name: null })),
  });
  const info = await archive.json(`${root}/projects/${project}/info.json`, { name: 'Project' });
  await archive.json(`${root}/projects/${project}/manifest.json`, { files: [info] });
  await archive.json(`${root}/projects/${project}/assets-index.json`, {
    files: [],
    missing: [
      { id: 'file_project_new', reason: 'Download deferred to later file recovery' },
      { id: 'file_project_denied', reason: 'permission_error' },
    ],
    names: [
      { id: 'file_project_new', name: 'fresh.txt' },
      { id: 'file_project_denied', name: 'broken.txt' },
    ],
  });
  return archive;
}
const accountResponse = { accounts: { self: {
  account: { account_id: account, account_name: 'Test' },
} } };

test('sync only deferred files, skip prior denials, retain verified bytes and conversation checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-asset-sync-'));
  try {
    const archive = await fixture(dir);
    const requests: string[] = [];
    const progressStates: ProgressSnapshot[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        requests.push(path);
        if (path.includes('accounts/check')) return accountResponse;
        if (path.includes('/files/')) return { status: 'error', error_code: 'permission_error' };
        throw new Error('No conversation or inventory requests allowed: ' + path);
      },
      openFile: async path => {
        requests.push(path);
        if (path.includes('file_new_good')) return binary('new conversation attachment');
        if (path.includes('file_project_new')) return binary('new Project attachment');
        if (path.includes('file_new_denied')) return new Response('forbidden', { status: 403 });
        throw new Error('Previously denied asset should not be retried: ' + path);
      },
    };
    const result = await syncMissingAttachments(api, dir,
      new Progress(snapshot => progressStates.push(snapshot), false), () => false);
    assert.equal(result.status, 'finished');
    assert.equal(result.totalMissing, 6);
    assert.equal(result.eligible, 4);
    assert.equal(result.processed, 4);
    assert.equal(result.recovered, 3);
    assert.equal(result.alreadyVerified, 1);
    assert.equal(result.unavailable, 1);
    assert.equal(result.previouslyUnavailable, 2);
    assert.equal(result.attempted, 3);
    assert.equal(result.remaining, 3);
    assert.ok(requests.every(path => path.includes('accounts/check') || path.includes('/backend-api/files/')));
    assert.ok(requests.every(path => !path.includes('file_old_denied') && !path.includes('file_project_denied')));
    const marker = await archive.marker(key, conversation);
    assert.equal(marker?.missing.length, 2);
    assert.equal(marker?.files.length, 2);
    assert.ok(marker?.files.every(file => file.path.includes('/assets/')));
    assert.equal(await readFile(archive.path(marker!.files.find(x => x.path.endsWith('file_already_saved'))!.path), 'utf8'), 'old bytes');
    assert.equal(await readFile(archive.path(marker!.files.find(x => x.path.endsWith('file_new_good'))!.path), 'utf8'), 'new conversation attachment');
    const projectIndex = await archive.read<{ files: Array<{ path: string }>; missing: unknown[] }>(
      `${root}/projects/${project}/assets-index.json`);
    assert.equal(projectIndex?.files.length, 1);
    assert.equal(projectIndex?.missing.length, 1);
    const manifest = await archive.read<{ files: Array<{ path: string }> }>(
      `${root}/projects/${project}/manifest.json`);
    assert.equal(manifest?.files.length, 2);
    assert.equal((await inspectArchive(dir))?.deferredFiles, 0);
    assert.equal((await inspectArchive(dir))?.unavailableFiles, 3);
    assert.ok(progressStates.some(state => state.stage === 'Syncing attachments'
      && state.done === 4 && state.total === 4 && state.attachments?.recovered === 3));
    const numberBefore = requests.length;
    const second = await syncMissingAttachments(api, dir, new Progress(undefined, false), () => false);
    assert.equal(second.eligible, 0, 'permanently denied/attempted references are not repeated automatically');
    assert.equal(second.recovered, 0);
    assert.equal(requests.length, numberBefore + 1, 'only the workspace check is repeated');
    const latest = await archive.read<{ status: string; remaining: number }>('attachment-sync-latest.json');
    assert.equal(latest?.status, 'finished');
    assert.equal(latest?.remaining, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unlisted IDs are marked unavailable without requesting nonexistent files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-asset-unlisted-'));
  try {
    const archive = await fixture(dir);
    const raw = await archive.json(`${root}/conversations/${conversation}/raw.json`, {
      id: conversation, messages: [],
    });
    const marker = (await archive.marker(key, conversation))!;
    await archive.json(`${root}/conversations/${conversation}/complete.json`, {
      ...marker, raw, files: [], missing: [
        { id: 'file_unlisted', reason: 'Download deferred to later file recovery' },
      ],
    } satisfies CompletionMarker);
    await archive.json(`${root}/conversations/${conversation}/assets-index.json`, {
      files: [], missing: [{ id: 'file_unlisted', reason: 'Download deferred to later file recovery' }],
    });
    const calls: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        calls.push(path);
        if (path.includes('accounts/check')) return accountResponse;
        if (path.includes('/files/')) return { status: 'error', error_code: 'permission_error' };
        throw new Error('Unexpected request ' + path);
      },
      openFile: async path => { calls.push(path); return binary('project'); },
    };
    const result = await syncMissingAttachments(api, dir, new Progress(undefined, false), () => false);
    assert.equal(result.unlisted, 1);
    assert.equal(result.remaining, 2, 'unlisted conversation ID and denied Project ID remain');
    const after = await archive.marker(key, conversation);
    assert.equal(after?.missing[0]?.reason, 'Absent from saved source metadata');
    assert.ok(calls.every(path => !path.includes('file_unlisted')));
    const second = await syncMissingAttachments(api, dir, new Progress(undefined, false), () => false);
    assert.equal(second.eligible, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a rate-limit interruption retains first saved file and resumes with only the remaining target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-asset-restart-'));
  try {
    const archive = new Archive(dir);
    const inventory: Inventory = {
      schema: 1, generatedAt: '2026-11-12T00:00:00Z',
      conversations: [{ id: conversation, title: 'Test', updated: 1 }],
      projects: [], shared: [], warnings: [],
      scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
    };
    await archive.json(`${root}/inventory.json`, inventory);
    const raw = await archive.json(`${root}/conversations/${conversation}/raw.json`, {
      id: conversation, messages: [{ content: { parts: [
        { file_id: 'file_one' }, { file_id: 'file_two' },
      ] } }],
    });
    const marker: CompletionMarker = {
      schema: 1, id: conversation, updated: 1, raw, files: [], completedAt: '2026-11-12T00:00:00Z',
      missing: [
        { id: 'file_one', reason: 'Download deferred to later file recovery' },
        { id: 'file_two', reason: 'Download deferred to later file recovery' },
      ],
    };
    await archive.json(`${root}/conversations/${conversation}/complete.json`, marker);
    let first = true;
    const downloads: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        if (path.includes('accounts/check')) return accountResponse;
        throw new Error('No metadata request expected ' + path);
      },
      openFile: async path => {
        downloads.push(path);
        if (path.includes('file_two') && first) throw new RateLimitExhausted('asset-binary');
        return binary('saved bytes');
      },
    };
    await assert.rejects(
      syncMissingAttachments(api, dir, new Progress(undefined, false), () => false),
      error => error instanceof RateLimitExhausted);
    const interrupted = await archive.read<{ status: string; processed: number; remaining: number }>(
      'attachment-sync-latest.json');
    assert.equal(interrupted?.status, 'interrupted');
    assert.equal(interrupted?.processed, 1);
    assert.equal(interrupted?.remaining, 1);
    assert.equal((await archive.marker(key, conversation))?.missing.length, 1);
    first = false;
    const before = downloads.length;
    const resumed = await syncMissingAttachments(api, dir, new Progress(undefined, false), () => false);
    assert.equal(resumed.eligible, 1);
    assert.equal(resumed.recovered, 1);
    assert.equal(resumed.remaining, 0);
    assert.ok(downloads.slice(before).every(path => path.includes('file_two')));
    assert.equal((await archive.marker(key, conversation))?.files.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Stop safely keeps all earlier per-file checkpoints and does not start another download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-asset-stop-'));
  try {
    const archive = new Archive(dir);
    const inventory: Inventory = {
      schema: 1, generatedAt: '2026-11-12T00:00:00Z',
      conversations: [{ id: conversation, title: 'Test', updated: 1 }],
      projects: [], shared: [], warnings: [],
      scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
    };
    await archive.json(`${root}/inventory.json`, inventory);
    const raw = await archive.json(`${root}/conversations/${conversation}/raw.json`, {
      id: conversation, messages: [{ content: { parts: [
        { file_id: 'file_one' }, { file_id: 'file_two' },
      ] } }],
    });
    await archive.json(`${root}/conversations/${conversation}/complete.json`, {
      schema: 1, id: conversation, updated: 1, raw, files: [],
      missing: [
        { id: 'file_one', reason: 'Download deferred to later file recovery' },
        { id: 'file_two', reason: 'Download deferred to later file recovery' },
      ],
      completedAt: '2026-11-12T00:00:00Z',
    } satisfies CompletionMarker);
    let stop = false;
    const requests: string[] = [];
    const api: ChatGptApi = {
      cancel: () => { stop = true; },
      get: async path => {
        if (path.includes('accounts/check')) return accountResponse;
        throw new Error('Unexpected request ' + path);
      },
      openFile: async path => { requests.push(path); stop = true; return binary('first file'); },
    };
    await assert.rejects(syncMissingAttachments(api, dir, new Progress(undefined, false), () => stop),
      error => error instanceof ExportCancelledError);
    assert.equal(requests.length, 1, 'cancellation blocks the second file request');
    assert.equal((await archive.marker(key, conversation))?.missing.length, 1);
    assert.equal((await archive.read<{ status: string }>('attachment-sync-latest.json'))?.status, 'stopped');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('automatic sync continues after 60 denied files to reach later recoverable assets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-asset-denial-fuse-'));
  try {
    const archive = new Archive(dir);
    const inventory: Inventory = {
      schema: 1, generatedAt: '2026-11-12T00:00:00Z',
      conversations: [{ id: conversation, title: 'Many denied files', updated: 1 }],
      projects: [], shared: [], warnings: [],
      scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
    };
    await archive.json(`${root}/inventory.json`, inventory);
    const names = Array.from({ length: 61 }, (_, index) => `file_denied_${index}`);
    const raw = await archive.json(`${root}/conversations/${conversation}/raw.json`, {
      id: conversation, messages: [{ content: { parts: names.map(file_id => ({ file_id })) } }],
    });
    const missing = names.map(id => ({ id, reason: 'Download deferred to later file recovery' }));
    await archive.json(`${root}/conversations/${conversation}/complete.json`, {
      schema: 1, id: conversation, updated: 1, raw, files: [], missing,
      completedAt: '2026-11-12T00:00:00Z',
    } satisfies CompletionMarker);
    let fileRequests = 0;
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        if (path.includes('accounts/check')) return accountResponse;
        fileRequests++;
        if (path.includes('file_denied_60')) {
          return { status: 'success', download_url: 'https://chatgpt.com/backend-api/files/file_denied_60/download' };
        }
        throw new ApiError(403, path, 'HTTP 403');
      },
      openFile: async path => {
        fileRequests++;
        return path.includes('file_denied_60')
          ? binary('recovered after sixty failed files')
          : new Response('not found', { status: 404 });
      },
    };
    const result = await syncMissingAttachments(api, dir, new Progress(undefined, false), () => false);
    assert.equal(result.status, 'finished', 'unavailable streaks do not terminate the full pass');
    assert.equal(result.eligible, 61);
    assert.equal(result.processed, 61, 'all 61 queued references are inspected');
    assert.equal(result.unavailable, 60);
    assert.equal(result.recovered, 1, 'later accessible asset can still be recovered');
    assert.equal(result.remaining, 60);
    assert.ok(fileRequests >= 121 && fileRequests <= 122,
      'each denied file has two route trials and later successful file has at most two');
    assert.equal((await inspectArchive(dir))?.deferredFiles, 0);
    assert.equal((await inspectArchive(dir))?.unavailableFiles, 60);
    const marker = await archive.marker(key, conversation);
    assert.equal(marker?.files.length, 1);
    assert.equal(await readFile(archive.path(marker!.files[0]!.path), 'utf8'),
      'recovered after sixty failed files');
    const resumed = await syncMissingAttachments(api, dir, new Progress(undefined, false), () => false);
    assert.equal(resumed.eligible, 0, 'only truly unattempted/deferred assets are automatically queued');
    assert.equal(resumed.remaining, 60);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
