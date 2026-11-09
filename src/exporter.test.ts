import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from './archive.js';
import { ExportCancelledError, ResourceDeniedError, SessionExpiredError } from './errors.js';
import { exportWorkspace } from './exporter.js';
import { Progress, type ProgressSnapshot } from './progress.js';
import type { ChatGptApi } from './api-types.js';
import type { Inventory } from './discovery.js';

test('expired sign-in interrupts the export instead of marking every conversation as failed', async () => {
  const output = await mkdtemp(join(tmpdir(), 'cde-auth-check-'));
  try {
    const workspace = { key: 'account_sample', id: 'workspace_test', label: 'Test', kind: 'personal' };
    const archive = new Archive(output);
    const inventory: Inventory = {
      schema: 1, generatedAt: new Date().toISOString(),
      conversations: [{ id: 'chat_1', title: 'First', updated: 1 }],
      projects: [], shared: [], warnings: [],
      scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
    };
    await archive.json(`workspaces/${workspace.key}/inventory.json`, inventory);
    let cancelled = false;
    const api: ChatGptApi = {
      get: async path => {
        if (path.startsWith('/backend-api/conversations/')) throw new SessionExpiredError(path);
        return { items: [] };
      },
      cancel: () => { cancelled = true; },
    };
    await assert.rejects(exportWorkspace(api, archive, workspace, new Progress(undefined, false),
      { output, concurrency: 1, assets: false, max: undefined, refresh: false }, () => cancelled),
    error => error instanceof SessionExpiredError && error.status === 401);
    assert.equal(cancelled, true);
    const interrupted = await archive.read<{ failed: Array<{ id: string }> }>(`workspaces/${workspace.key}/interrupted.json`);
    assert.equal(interrupted?.failed.length, 0);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('a denied conversation does not abort other chats and the progress bar counts saved data only', async () => {
  const output = await mkdtemp(join(tmpdir(), 'cde-access-check-'));
  try {
    const workspace = { key: 'account_sample', id: 'workspace_test', label: 'Test', kind: 'business' };
    const archive = new Archive(output);
    const inventory: Inventory = {
      schema: 1, generatedAt: new Date().toISOString(),
      conversations: [
        { id: 'chat_denied', title: 'Denied', updated: 1 },
        { id: 'chat_allowed', title: 'Allowed', updated: 1 },
      ],
      projects: [], shared: [], warnings: [],
      scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
    };
    await archive.json(`workspaces/${workspace.key}/inventory.json`, inventory);
    const updates: ProgressSnapshot[] = [];
    const progress = new Progress(state => { updates.push(state); }, false);
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        if (path.includes('chat_denied')) throw new ResourceDeniedError(path);
        if (path.startsWith('/backend-api/conversations/chat_allowed')) {
          return { id: 'chat_allowed', messages: [{ id: 'message_one', content: { parts: ['content'] } }],
            page_info: { has_previous_page: false, has_next_page: false } };
        }
        if (path.startsWith('/public-api/gizmos/discovery/mine')) return { items: [] };
        return {};
      },
    };
    const report = await exportWorkspace(api, archive, workspace, progress,
      { output, concurrency: 1, assets: true, max: undefined, refresh: false }, () => false);
    assert.equal(report.completed, 1);
    assert.equal((report.failed as Array<{ id: string }>).length, 1);
    assert.equal((report.failed as Array<{ id: string }>)[0]?.id, 'chat_denied');
    const last = updates.filter(update => update.stage === 'Capturing').at(-1);
    assert.equal(last?.done, 2, 'the progress bar counts both finished attempts, not just fully saved results');
    assert.equal(last?.total, 2);
    assert.deepEqual(last?.capture, {
      attempted: 2, complete: 1, partial: 0, failed: 1, reused: 0, active: 0,
    });
    assert.ok(updates.some(update => update.message?.includes('failed (HTTP 401)')));
    assert.equal(await archive.canSkip(workspace.key, 'chat_allowed', 1, true), true);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('one fatal HTTP 401 keeps the original cause and never journals cancellation fallout', async () => {
  const output = await mkdtemp(join(tmpdir(), 'cde-cancel-cascade-'));
  try {
    const workspace = { key: 'account_sample', id: 'workspace_test', label: 'Test', kind: 'business' };
    const archive = new Archive(output);
    const inventory: Inventory = {
      schema: 1, generatedAt: new Date().toISOString(),
      conversations: [
        { id: 'chat_expired', title: 'Expired', updated: 1 },
        { id: 'chat_inflight', title: 'In flight', updated: 1 },
        { id: 'chat_unstarted', title: 'Not started', updated: 1 },
      ],
      projects: [], shared: [], warnings: [],
      scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
    };
    await archive.json(`workspaces/${workspace.key}/inventory.json`, inventory);

    let cancelled = false;
    let releaseInFlight: (() => void) | undefined;
    let signalInFlightStarted!: () => void;
    const inFlightStarted = new Promise<void>(resolve => { signalInFlightStarted = resolve; });
    const requests: string[] = [];
    const endpoint = '/backend-api/conversations/chat_expired?include_has_versions=true&num_turns=100';
    const api: ChatGptApi = {
      get: async path => {
        if (path.includes('chat_expired')) {
          // Ensure the second request is in flight before expiring the session:
          // Node 22 can schedule these otherwise and leave the mock unresolved.
          await inFlightStarted;
          throw new SessionExpiredError(path);
        }
        if (path.includes('chat_inflight')) {
          requests.push('inflight');
          await new Promise<void>(resolve => { releaseInFlight = resolve; signalInFlightStarted(); });
          if (cancelled) throw new ExportCancelledError();
          throw new Error('This request was supposed to be cancelled');
        }
        if (path.includes('chat_unstarted')) requests.push('unstarted');
        if (path.startsWith('/public-api/gizmos/discovery/mine')) return { items: [] };
        return {};
      },
      cancel: () => { cancelled = true; releaseInFlight?.(); },
    };

    await assert.rejects(exportWorkspace(api, archive, workspace, new Progress(undefined, false),
      { output, concurrency: 2, assets: true, max: undefined, refresh: false }, () => cancelled),
    error => error instanceof SessionExpiredError && error.endpoint === endpoint);

    assert.deepEqual(requests, ['inflight'], 'a third conversation must never start');
    const interrupted = await archive.read<{
      attempted: number;
      failed: Array<{ id: string }>;
      cause: { name: string; httpStatus: number; endpoint: string };
    }>(`workspaces/${workspace.key}/interrupted.json`);
    assert.equal(interrupted?.attempted, 0, 'cancelled requests are not completed or failed attempts');
    assert.deepEqual(interrupted?.failed, [], 'do not record spurious conversation failures');
    assert.deepEqual(interrupted?.cause, {
      name: 'SessionExpiredError', httpStatus: 401, endpoint,
    });
    const journal = await readFile(archive.path(`workspaces/${workspace.key}/journal.jsonl`), 'utf8')
      .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    assert.doesNotMatch(journal, /"event":"error"/);
  } finally { await rm(output, { recursive: true, force: true }); }
});


test('the 25-chat pilot samples three relevant Projects while full export includes all of them', async () => {
  const output = await mkdtemp(join(tmpdir(), 'cde-project-pilot-'));
  try {
    const workspace = { key: 'account_sample', id: 'workspace_test', label: 'Test', kind: 'business' };
    const archive = new Archive(output);
    const projects = [
      { id: 'g-p-a', raw: {}, files: [] },
      { id: 'g-p-b', raw: {}, files: [] },
      { id: 'g-p-c', raw: {}, files: [{ file_id: 'file_c' }] },
      { id: 'g-p-d', raw: {}, files: [{ file_id: 'file_d' }] },
      { id: 'g-p-e', raw: {}, files: [{ file_id: 'file_e' }] },
    ];
    const inventory: Inventory = {
      schema: 1, generatedAt: new Date().toISOString(),
      conversations: [{ id: 'chat_one', title: 'Sample', updated: 1, projectId: 'g-p-c' }],
      projects, shared: [], warnings: [],
      scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
    };
    await archive.json(`workspaces/${workspace.key}/inventory.json`, inventory);
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        if (path.startsWith('/backend-api/conversations/chat_one')) {
          return { id: 'chat_one', messages: [], page_info: { has_previous_page: false } };
        }
        if (path.startsWith('/public-api/gizmos/discovery/mine')) return { items: [] };
        return {};
      },
    };
    const updates: string[] = [];
    const progress = new Progress(state => { if (state.message) updates.push(state.message); }, false);
    const pilot = await exportWorkspace(api, archive, workspace, progress,
      { output, concurrency: 1, assets: false, max: 25, refresh: false }, () => false);
    assert.deepEqual(pilot.projectCoverage, { total: 5, checked: 3, sampled: true });
    assert.equal(pilot.status, 'partial', 'a pilot never claims to be the entire archive');
    for (const project of ['g-p-c', 'g-p-d', 'g-p-e']) {
      assert.ok(await archive.read(`workspaces/${workspace.key}/projects/${project}/manifest.json`));
    }
    assert.equal(await archive.read(`workspaces/${workspace.key}/projects/g-p-a/manifest.json`), undefined);
    assert.equal(await archive.read(`workspaces/${workspace.key}/projects/g-p-b/manifest.json`), undefined);
    assert.ok(updates.some(message => message.includes('3/5 representative Projects')));
    assert.ok(updates.some(message => message.includes('Projects: 3/3 metadata saved')));

    const full = await exportWorkspace(api, archive, workspace, new Progress(undefined, false),
      { output, concurrency: 1, assets: false, max: undefined, refresh: false }, () => false);
    assert.deepEqual(full.projectCoverage, { total: 5, checked: 5, sampled: false });
    assert.ok(await archive.read(`workspaces/${workspace.key}/projects/g-p-a/manifest.json`));
    assert.ok(await archive.read(`workspaces/${workspace.key}/projects/g-p-b/manifest.json`));
  } finally { await rm(output, { recursive: true, force: true }); }
});
