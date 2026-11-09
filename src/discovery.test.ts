import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, type ChatGptBrowser } from './browser.js';
import { buildInventory, discoverWorkspaces, readDetail } from './discovery.js';
import { Progress } from './progress.js';

const mock = (handler: (path: string) => unknown | Promise<unknown>): ChatGptBrowser => ({
  get: async (path: string) => handler(path),
}) as unknown as ChatGptBrowser;
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
