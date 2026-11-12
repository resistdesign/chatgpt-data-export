import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, type CompletionMarker } from './archive.js';
import { refreshRecentInventory, type Inventory } from './discovery.js';
import { exportWorkspace } from './exporter.js';
import { Progress } from './progress.js';
import { RateLimitExhausted } from './errors.js';
import type { ChatGptApi } from './api-types.js';

const workspace = { id: 'account-1', key: 'work_1', label: 'Test', kind: 'business' };
const progress = () => new Progress(undefined, false);
const baseInventory = (chats: Inventory['conversations'], projects: Inventory['projects'] = []): Inventory => ({
  schema: 1,
  generatedAt: '2026-11-08T00:00:00Z',
  conversations: chats,
  projects, shared: [], warnings: [],
  scopes: { main: 'complete', archived: 'complete', projects: 'complete', shared: 'complete' },
});

test('recent scan merges new main, archived and Project-only chats without dropping previous inventory', async () => {
  const oldChats = Array.from({ length: 100 }, (_, index) => ({
    id: `chat_${index.toString().padStart(3, '0')}`, title: `Old ${index}`, updated: 1,
  }));
  oldChats[50] = { ...oldChats[50]!, projectId: 'g-p-old' } as typeof oldChats[number];
  const original = baseInventory(oldChats, [{ id: 'g-p-old', raw: { status: 'old' }, details: { files: [] }, files: [] }]);
  const calls: string[] = [];
  const api: ChatGptApi = {
    cancel: () => undefined,
    get: async path => {
      calls.push(path);
      if (path.startsWith('/backend-api/conversations?')) {
        if (path.includes('is_archived=true')) {
          return { items: [{ id: 'chat_archived_new', title: 'Archived new', update_time: 8 }] };
        }
        const main = [
          { id: 'chat_main_new', title: 'Brand new', update_time: 9 },
          { id: 'chat_000', title: 'Title revised', update_time: 7 },
          ...oldChats.slice(1, 99).map(v => ({ id: v.id, title: v.title, update_time: v.updated })),
        ];
        return { items: main };
      }
      if (path.includes('snorlax/sidebar')) return { items: [
        { gizmo: { gizmo: { id: 'g-p-old' }, files: [] } },
        { gizmo: { gizmo: { id: 'g-p-new' }, files: [] } },
      ], cursor: null };
      if (path.includes('/gizmos/g-p-new/conversations')) return {
        items: [{ id: 'chat_project_new', title: 'From Project', update_time: 10 }], cursor: null,
      };
      if (path.includes('/gizmos/g-p-old/conversations')) return {
        items: [{ id: 'chat_050', title: 'Old 50', update_time: 1 }], cursor: null,
      };
      if (path === '/backend-api/gizmos/g-p-new') return { gizmo: { id: 'g-p-new' }, files: [] };
      if (path.includes('shared_conversations')) return { items: [] };
      throw new Error(`Unexpected endpoint: ${path}`);
    },
  };
  const result = await refreshRecentInventory(api, workspace, original, progress());
  assert.deepEqual(result.newIds.sort(), ['chat_archived_new', 'chat_main_new', 'chat_project_new']);
  assert.deepEqual(result.changedIds.sort(), ['chat_000', 'chat_archived_new', 'chat_main_new', 'chat_project_new']);
  assert.equal(result.inventory.conversations.length, 103);
  assert.equal(result.inventory.conversations.find(chat => chat.id === 'chat_000')?.updated, 7);
  assert.equal(result.inventory.conversations.find(chat => chat.id === 'chat_archived_new')?.archived, true);
  assert.equal(result.inventory.conversations.find(chat => chat.id === 'chat_project_new')?.projectId, 'g-p-new');
  assert.equal(result.inventory.projects.length, 2);
  assert.equal(result.inventory.projects.find(project => project.id === 'g-p-old')?.details !== undefined, true);
  assert.deepEqual(result.newProjectIds, ['g-p-new']);
  assert.equal(original.conversations.length, 100, 'original inventory is not mutated');
  assert.equal(result.requests.main, 1, 'one recent page suffices when most entries are unchanged');
  assert.equal(result.requests.archived, 1);
  assert.equal(result.requests.projects, 4);
  assert.equal(result.inventory.sync?.new, 3);
  assert.equal(result.inventory.sync?.updated, 1);
  assert.ok(calls.every(p => !p.includes('offset=95')), 'older full listing pages were not fetched');
});

test('all-known main entries without archived:false metadata must not trigger a complete re-fetch', async () => {
  const oldChats = Array.from({ length: 100 }, (_, index) => ({
    id: `chat_${index.toString().padStart(3, '0')}`, title: 'Old', updated: 1,
  }));
  const inventory = baseInventory(oldChats);
  const requested: string[] = [];
  const api: ChatGptApi = {
    cancel: () => undefined,
    get: async path => {
      requested.push(path);
      if (path.startsWith('/backend-api/conversations?')) {
        return path.includes('is_archived=true') ? { items: [] }
          : { items: oldChats.map(item => ({ id: item.id, title: item.title, update_time: 1 })) };
      }
      if (path.includes('snorlax/sidebar') || path.includes('shared_conversations')) return { items: [] };
      throw new Error('Unexpected request');
    },
  };
  const result = await refreshRecentInventory(api, workspace, inventory, progress());
  assert.deepEqual(result.changedIds, []);
  assert.equal(result.requests.main, 1);
  assert.equal(result.inventory.conversations.length, 100);
  assert.equal(requested.length, 4);
});

test('incremental backup downloads only changed and new conversation records, with no asset or account requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cde-sync-'));
  try {
    const archive = new Archive(directory);
    const root = `workspaces/${workspace.key}`;
    const inventory = baseInventory([
      { id: 'chat_old', title: 'Unchanged', updated: 1 },
      { id: 'chat_edited', title: 'Edited', updated: 1 },
    ]);
    await archive.json(`${root}/inventory.json`, inventory);
    const oldRaw = await archive.json(`${root}/conversations/chat_old/raw.json`, { id: 'chat_old', messages: [] });
    const editedRaw = await archive.json(`${root}/conversations/chat_edited/raw.json`, { id: 'chat_edited', messages: [] });
    const marker = (id: string, raw: typeof oldRaw): CompletionMarker => ({
      schema: 1, id, updated: 1, raw, files: [], missing: [], completedAt: '2026-11-08T00:00:00Z',
    });
    await archive.json(`${root}/conversations/chat_old/complete.json`, marker('chat_old', oldRaw));
    await archive.json(`${root}/conversations/chat_edited/complete.json`, marker('chat_edited', editedRaw));
    const oldContent = await readFile(archive.path(oldRaw.path), 'utf8');
    const editedContent = await readFile(archive.path(editedRaw.path), 'utf8');
    const requests: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => {
        requests.push(path);
        if (path.startsWith('/backend-api/conversations?')) {
          return path.includes('is_archived=true') ? { items: [] } : { items: [
            { id: 'chat_new', title: 'Brand new', update_time: 3 },
            { id: 'chat_edited', title: 'Edited', update_time: 2 },
            { id: 'chat_old', title: 'Unchanged', update_time: 1 },
          ] };
        }
        if (path.includes('snorlax/sidebar') || path.includes('shared_conversations')) return { items: [] };
        if (path.includes('/backend-api/conversations/chat_new')) return {
          id: 'chat_new', messages: [{ id: 'new-message', content: { parts: ['hello'] } }],
          page_info: { has_previous_page: false },
        };
        if (path.includes('/backend-api/conversations/chat_edited')) return {
          id: 'chat_edited', messages: [{ id: 'edited-message', content: { parts: ['edited'] } }],
          page_info: { has_previous_page: false },
        };
        throw new Error('Unexpected endpoint: ' + path);
      },
      openFile: async () => { throw new Error('Asset downloads are disabled'); },
    };
    const report = await exportWorkspace(api, archive, workspace, progress(),
      { output: directory, concurrency: 2, max: undefined, assets: false, refresh: false, sync: true },
      () => false);
    assert.equal(report.selected, 2);
    assert.equal(report.completed, 2);
    assert.equal(report.skipped, 0);
    assert.deepEqual(report.incrementalSync, {
      new: 1, updated: 1, listingRequests: { main: 1, archived: 1, projects: 1, shared: 1 },
      selected: 2, updatedAt: (report.incrementalSync as { updatedAt: string }).updatedAt,
    });
    assert.equal(requests.filter(path => path.includes('/backend-api/conversations/chat_old')).length, 0);
    assert.equal(requests.filter(path => path.includes('/backend-api/conversations/chat_new')).length, 1);
    assert.equal(requests.filter(path => path.includes('/backend-api/conversations/chat_edited')).length, 1);
    assert.equal(requests.filter(path => path.startsWith('/backend-api/files/')).length, 0);
    assert.equal(requests.filter(path => path.startsWith('/public-api/')).length, 0);
    assert.equal(await readFile(archive.path(oldRaw.path), 'utf8'), oldContent);
    assert.equal(await readFile(archive.path(editedRaw.path), 'utf8'), editedContent,
      'previous raw conversation revision must remain byte-for-byte intact');
    const editedMarker = await archive.marker(workspace.key, 'chat_edited');
    assert.match(editedMarker?.raw.path ?? '', /\/revisions\/.*\.json$/,
      'updated chats should use a new content-addressed file');
    const savedPreviousMarker = await archive.read<CompletionMarker>(
      `${root}/conversations/chat_edited/revisions/${editedRaw.sha256}.marker.json`,
    );
    assert.equal(savedPreviousMarker?.raw.sha256, editedRaw.sha256);
    assert.equal(await archive.canSkip(workspace.key, 'chat_old', 1, false), true);
    assert.equal(await archive.canSkip(workspace.key, 'chat_new', 3, false), true);
    assert.equal(await archive.canSkip(workspace.key, 'chat_edited', 2, false), true);
    const updated = await archive.read<Inventory>(`${root}/inventory.json`);
    assert.equal(updated?.conversations.length, 3);
    assert.equal(updated?.sync?.new, 1);
    const verified = await archive.verifyWorkspace(workspace.key);
    assert.equal(verified.expected, 3);
    assert.equal(verified.failed.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed incremental discovery never replaces the known-good inventory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cde-sync-rollback-'));
  try {
    const archive = new Archive(directory);
    const inventory = baseInventory([{ id: 'chat_saved', title: 'Saved', updated: 1 }]);
    const path = `workspaces/${workspace.key}/inventory.json`;
    await archive.json(path, inventory);
    const before = await archive.fileHash(path);
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async request => {
        if (request.includes('is_archived=true')) throw new RateLimitExhausted(request);
        if (request.startsWith('/backend-api/conversations?')) {
          return { items: [{ id: 'chat_new', title: 'New', update_time: 5 }] };
        }
        throw new Error('Must abort before scanning other endpoints');
      },
    };
    await assert.rejects(exportWorkspace(api, archive, workspace, progress(),
      { output: directory, concurrency: 1, max: undefined, assets: false, refresh: false, sync: true },
      () => false), error => error instanceof RateLimitExhausted);
    assert.equal(await archive.fileHash(path), before);
    assert.equal((await archive.read<Inventory>(path))?.conversations.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
