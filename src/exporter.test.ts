import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from './archive.js';
import { ApiError } from './errors.js';
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
        if (path.startsWith('/backend-api/conversations/')) throw new ApiError(401, path, 'Login expired');
        return { items: [] };
      },
      cancel: () => { cancelled = true; },
    };
    await assert.rejects(exportWorkspace(api, archive, workspace, new Progress(undefined, false),
      { output, concurrency: 1, assets: false, max: undefined, refresh: false }, () => cancelled),
    error => error instanceof ApiError && error.status === 401);
    assert.equal(cancelled, true);
    const interrupted = await archive.read<{ failed: Array<{ id: string }> }>(`workspaces/${workspace.key}/interrupted.json`);
    assert.equal(interrupted?.failed.length, 0);
  } finally { await rm(output, { recursive: true, force: true }); }
});
