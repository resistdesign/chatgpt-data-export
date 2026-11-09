import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from './archive.js';
import { ResourceDeniedError, SessionExpiredError } from './errors.js';
import { exportWorkspace } from './exporter.js';
import { Progress } from './progress.js';
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
    const updates: Array<{ stage: string; done: number; total: number; note: string; message?: string }> = [];
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
    assert.equal(last?.done, 1, 'one verified conversation saved, not two');
    assert.equal(last?.total, 2);
    assert.match(last?.note ?? '', /2 attempted; 1 complete; 0 partial; 0 reused; 1 errors/);
    assert.ok(updates.some(update => update.message?.includes('failed (HTTP 401)')));
    assert.equal(await archive.canSkip(workspace.key, 'chat_allowed', 1, true), true);
  } finally { await rm(output, { recursive: true, force: true }); }
});
