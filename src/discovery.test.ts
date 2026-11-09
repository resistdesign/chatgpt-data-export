import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ResourceDeniedError, SessionExpiredError } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import { buildInventory, discoverWorkspaces, readDetail } from './discovery.js';
import { Progress } from './progress.js';

const mock = (handler: (path: string) => unknown | Promise<unknown>): ChatGptApi => ({
  get: async (path: string) => handler(path),
}) as unknown as ChatGptApi;
const workspace = { id: 'account-1', key: 'workspace', label: 'Personal', kind: 'personal' };

test('workspace discovery requires real account records', async () => {
  const api = mock(() => ({ accounts: { personal: { account: { account_id: 'account-1', account_name: 'Personal' }, structure: 'personal' } } }));
  assert.equal((await discoverWorkspaces(api))[0]?.label, 'Personal');
  await assert.rejects(discoverWorkspaces(mock(() => ({ accounts: {} }))), /Could not discover/);
});

test('inventory joins main, archived, Project and shared-only listings', async () => {
  const api = mock(path => {
    if (path.startsWith('/backend-api/conversations?')) {
      return path.includes('is_archived=true') ? { items: [{ id: 'chat_b', title: 'Archive', update_time: 8 }] } : { items: [{ id: 'chat_a', title: 'Main', update_time: 9 }] };
    }
    if (path.includes('snorlax/sidebar')) return { items: [{ gizmo: { gizmo: { id: 'g-p-123', display: { name: 'Work' } }, files: [] } }], cursor: null };
    if (path.includes('/gizmos/g-p-123/conversations')) return { items: [{ id: 'chat_c', title: 'Project', update_time: 7 }], cursor: null };
    if (path.includes('/gizmos/g-p-123')) return { gizmo: { id: 'g-p-123', instructions: 'Keep it short' }, files: [] };
    if (path.includes('shared_conversations')) return { items: [{ id: 'share_one' }] };
    throw new Error('Unexpected path ' + path);
  });
  const inventory = await buildInventory(api, workspace, new Progress());
  assert.equal(inventory.conversations.length, 3);
  assert.equal(inventory.projects.length, 1);
  assert.equal(inventory.shared.length, 1);
  assert.equal(inventory.scopes.main, 'complete');
  assert.equal(inventory.scopes.projects, 'complete');
});

test('Project inventory reports incremental progress and activity for each sidebar page', async () => {
  const updates: Array<{ stage: string; done: number; total: number; message?: string }> = [];
  const progress = new Progress(update => {
    updates.push({ stage: update.stage, done: update.done, total: update.total, message: update.message });
  }, false);
  const api = mock(path => {
    if (path.startsWith('/backend-api/conversations?')) return { items: [] };
    if (path.includes('snorlax/sidebar')) return {
      items: [
        { gizmo: { gizmo: { id: 'g-p-one' }, files: [] } },
        { gizmo: { gizmo: { id: 'g-p-two' }, files: [] } },
        { gizmo: { gizmo: { id: 'gpt-custom' }, files: [] } },
      ],
      cursor: null,
    };
    if (path.includes('/gizmos/g-p-one/conversations')) return { items: [{ id: 'chat_one' }] };
    if (path.includes('/gizmos/g-p-two/conversations')) return { items: [{ id: 'chat_two' }] };
    if (path.includes('/gizmos/g-p-')) return { files: [] };
    if (path.includes('shared_conversations')) return { items: [] };
    throw new Error('Unexpected path ' + path);
  });
  const inventory = await buildInventory(api, workspace, progress);
  assert.equal(inventory.projects.length, 2);
  const projectUpdates = updates.filter(update => update.stage === 'Inventory projects' && update.total === 2);
  assert.ok(projectUpdates.some(update => update.done === 1), 'first Project becomes visible before the second completes');
  assert.ok(projectUpdates.some(update => update.done === 2), 'sidebar page reaches 100% after both Projects');
  assert.ok(updates.some(update => update.message?.includes('Project inventory completed: 2 Projects')));
});

test('modern conversation pagination preserves every source page', async () => {
  const api = mock(path => {
    if (path.includes('/messages?')) return { messages: [{ id: 'old', content: { parts: ['hello'] } }], page_info: { has_previous_page: false, has_next_page: true } };
    return { id: 'chat_1', messages: [{ id: 'new', content: { parts: ['bye'] } }], page_info: { has_previous_page: true, has_next_page: false, start_cursor: 'cursor' } };
  });
  const result = await readDetail(api, workspace, 'chat_1') as { transport: string; sourcePages: unknown[] };
  assert.equal(result.transport, 'paginated');
  assert.equal(result.sourcePages.length, 2);
});

test('legacy graph fallback preserves raw branches', async () => {
  const api = mock(path => {
    if (path.includes('/backend-api/conversations/')) throw new ApiError(404, path, 'not found');
    return { id: 'chat_2', mapping: { root: { children: ['left', 'right'] } } };
  });
  const result = await readDetail(api, workspace, 'chat_2') as { transport: string; data: { mapping: unknown } };
  assert.equal(result.transport, 'legacy-graph');
  assert.ok(result.data.mapping);
});

test('invalid pagination cursor is rejected, not mistaken for completion', async () => {
  const api = mock(() => ({ id: 'chat_3', messages: [{ id: 'one' }], page_info: { has_previous_page: true, has_next_page: false } }));
  await assert.rejects(readDetail(api, workspace, 'chat_3'), /pagination stuck/);
});

test('legacy conversation fallback works when newer endpoint denies an otherwise accessible chat', async () => {
  const api = mock(path => {
    if (path.startsWith('/backend-api/conversations/')) throw new ResourceDeniedError(path);
    if (path.startsWith('/backend-api/conversation/')) {
      return { id: 'chat_archived', mapping: { root: { children: [] } } };
    }
    throw new Error('Unexpected path ' + path);
  });
  const result = await readDetail(api, workspace, 'chat_archived') as { transport: string };
  assert.equal(result.transport, 'legacy-graph');
});

test('expired login still aborts conversation access instead of attempting legacy fallback', async () => {
  let requests = 0;
  const api = mock(path => {
    requests++;
    throw new SessionExpiredError(path);
  });
  await assert.rejects(readDetail(api, workspace, 'chat_any'), error => error instanceof SessionExpiredError);
  assert.equal(requests, 1);
});
