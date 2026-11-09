import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, type CompletionMarker } from './archive.js';
import { deferAssets } from './assets.js';
import { exportWorkspace } from './exporter.js';
import { Progress, type ProgressSnapshot } from './progress.js';
import type { ChatGptApi } from './api-types.js';
import type { Inventory } from './discovery.js';

test('deferred asset indexing preserves existing file bytes and records unavailable attachments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-deferred-assets-'));
  try {
    const archive = new Archive(dir);
    const root = 'workspaces/account/conversations/chat_saved';
    const existing = await archive.atomic(`${root}/assets/file_existing`, 'verified original bytes');
    const source = { messages: [
      { id: 'message_1', content: { parts: [
        { file_id: 'file_existing' }, { file_id: 'file_not_downloaded' },
      ] } },
    ] };
    const result = await deferAssets(archive, root, source, {
      existing: [existing],
      existingMissing: [{ id: 'file_unavailable_before', reason: 'HTTP 403' }],
    });
    assert.equal(result.attempted, 0);
    assert.equal(result.files.length, 1);
    assert.equal(result.missing.length, 2);
    assert.deepEqual(result.missing.map(entry => entry.id).sort(),
      ['file_not_downloaded', 'file_unavailable_before']);
    assert.equal(result.missing.find(entry => entry.id === 'file_unavailable_before')?.reason, 'HTTP 403');
    assert.equal(await readFile(archive.path(existing.path), 'utf8'), 'verified original bytes');
    assert.ok(await archive.verified(existing));
    const index = await archive.read<{ files: unknown[]; missing: unknown[]; names: unknown[] }>(
      `${root}/assets-index.json`,
    );
    assert.equal(index?.files.length, 1);
    assert.equal(index?.missing.length, 2);
    assert.equal(index?.names.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('full history-first export reuses partial checkpoints, saves new raw chats, and never downloads attachments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-history-first-'));
  try {
    const archive = new Archive(dir);
    const workspace = { key: 'account_example', id: 'account-1', kind: 'business', label: 'Test' };
    const root = `workspaces/${workspace.key}`;
    const inventory: Inventory = {
      schema: 1, generatedAt: '2026-11-09T00:00:00Z',
      conversations: [
        { id: 'chat_saved', title: 'Fully saved', updated: 1 },
        { id: 'chat_partial', title: 'Incomplete file', updated: 1 },
        { id: 'chat_new', title: 'Not captured yet', updated: 1 },
      ],
      projects: [{ id: 'g-p-one', raw: {}, files: [{ file_id: 'file_project_missing', name: 'unavailable.txt' }] }],
      shared: [], warnings: [],
      scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
    };
    await archive.json(`${root}/inventory.json`, inventory);
    const existing = await archive.atomic(`${root}/conversations/chat_saved/assets/file_existing`, 'kept');
    const savedRaw = await archive.json(`${root}/conversations/chat_saved/raw.json`, {
      id: 'chat_saved', messages: [{ id: 'm1', content: { parts: [{ file_id: 'file_existing' }] } }],
    });
    const partialRaw = await archive.json(`${root}/conversations/chat_partial/raw.json`, {
      id: 'chat_partial', messages: [{ id: 'm2', content: { parts: [{ file_id: 'file_broken' }] } }],
    });
    const marker = (id: string, raw: typeof savedRaw, files: typeof existing[], missing: CompletionMarker['missing']): CompletionMarker =>
      ({ schema: 1, id, updated: 1, raw, files, missing, completedAt: '2026-11-08T00:00:00Z' });
    await archive.json(`${root}/conversations/chat_saved/complete.json`,
      marker('chat_saved', savedRaw, [existing], []));
    await archive.json(`${root}/conversations/chat_partial/complete.json`,
      marker('chat_partial', partialRaw, [], [{ id: 'file_broken', reason: 'HTTP 403' }]));

    const requests: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        requests.push(path);
        if (path.includes('chat_saved') || path.includes('chat_partial')) {
          throw new Error('An existing conversation was fetched again');
        }
        if (path.startsWith('/backend-api/conversations/chat_new')) {
          return {
            id: 'chat_new',
            messages: [{ id: 'm3', content: { parts: [{ file_id: 'file_new_upload' }] } }],
            page_info: { has_previous_page: false },
          };
        }
        if (path.startsWith('/public-api/gizmos/discovery/mine')) return { items: [] };
        if (path.startsWith('/backend-api/files/') && path !== '/backend-api/files/library') {
          throw new Error('File download endpoint must not be contacted');
        }
        return {};
      },
      openFile: async () => { throw new Error('Binary download must not be attempted'); },
    };
    const progressSnapshots: ProgressSnapshot[] = [];
    const report = await exportWorkspace(api, archive, workspace,
      new Progress(snapshot => progressSnapshots.push(snapshot), false),
      { output: dir, concurrency: 2, max: undefined, assets: false, refresh: false }, () => false);

    assert.equal(report.completed, 3);
    assert.equal(report.skipped, 2);
    assert.equal(report.partial, 2, 'both existing incomplete and newly deferred attachments count as partial');
    assert.equal(report.status, 'partial');
    assert.deepEqual(report.projectMissing, ['g-p-one']);
    assert.ok(requests.some(path => path.includes('chat_new')));
    assert.equal(requests.filter(path => path.includes('chat_saved') || path.includes('chat_partial')).length, 0);
    assert.equal(requests.filter(path => path.startsWith('/backend-api/files/') &&
      path !== '/backend-api/files/library').length, 0);
    const partial = await archive.marker(workspace.key, 'chat_partial');
    assert.equal(partial?.missing[0]?.reason, 'HTTP 403');
    const created = await archive.marker(workspace.key, 'chat_new');
    assert.ok(created && await archive.verified(created.raw));
    assert.equal(created.missing.length, 1);
    assert.equal(created.missing[0]?.id, 'file_new_upload');
    assert.match(created.missing[0]?.reason ?? '', /deferred/i);
    const index = await archive.read<{ missing: Array<{ id: string }> }>(
      `${root}/projects/g-p-one/assets-index.json`,
    );
    assert.equal(index?.missing[0]?.id, 'file_project_missing');
    assert.equal(await readFile(archive.path(existing.path), 'utf8'), 'kept');
    const verify = await archive.verifyWorkspace(workspace.key);
    assert.deepEqual({ expected: verify.expected, complete: verify.complete, partial: verify.partial },
      { expected: 3, complete: 1, partial: 2 });
    assert.ok(progressSnapshots.some(state =>
      state.stage === 'Verifying saved archive' && state.done === 3 && state.total === 3));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
