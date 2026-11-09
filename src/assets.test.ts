import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiError } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import { Archive } from './archive.js';
import { safeDownloadUrl, saveAssets } from './assets.js';
import type { Workspace } from './discovery.js';

const workspace: Workspace = { key: 'test-key', id: 'account-1', label: 'Test', kind: 'business' };
const binary = (text: string): Response => new Response(text, {
  status: 200, headers: { 'content-type': 'application/octet-stream' },
});

test('Project files use gizmo_id and fall back to a direct binary route after permission_error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-project-download-'));
  const calls: Array<{ path: string; scope: string | null | undefined }> = [];
  try {
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async (path, scope) => {
        calls.push({ path, scope });
        if (scope) return { status: 'error', error_code: 'permission_error' };
        throw new ApiError(403, path, 'HTTP 403');
      },
      openFile: async (path, scope) => {
        calls.push({ path, scope });
        return binary('project file contents');
      },
    };
    const archive = new Archive(dir);
    const progress: Array<{ processed: number; total: number; current: number; method: string }> = [];
    const assets = await saveAssets(api, archive, workspace, 'workspaces/test/projects/g-p-one',
      {}, { projectId: 'g-p-one', projectFiles: [{ file_id: 'file_project', name: 'notes.txt' }],
        onProgress: item => progress.push(item),
      });
    assert.equal(assets.missing.length, 0);
    assert.equal(assets.files.length, 1);
    assert.equal(await readFile(archive.path(assets.files[0]!.path), 'utf8'), 'project file contents');
    assert.ok(progress.some(item => item.method.includes('project-direct')), 'fallback method is visible while running');
    assert.deepEqual(progress.at(-1), { processed: 1, total: 1, current: 1, method: 'File saved' });
    assert.ok(calls[0]!.path.includes('?gizmo_id=g-p-one'));
    assert.ok(!calls[0]!.path.includes('inline='));
    assert.ok(calls.some(call => call.scope === null), 'a denied workspace header triggers a no-header retry');
    assert.ok(calls.some(call => call.path.includes('/files/file_project/download?gizmo_id=g-p-one')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('conversation asset can be signed by no-header fallback with no bearer sent to a CDN', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-conversation-download-'));
  const realFetch = globalThis.fetch;
  const seen: Array<{ path: string; scope: string | null | undefined }> = [];
  try {
    globalThis.fetch = async (_input, options) => {
      assert.equal(options?.credentials, 'omit');
      assert.equal(new Headers(options?.headers).has('authorization'), false);
      return binary('image bytes');
    };
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async (path, scope) => {
        seen.push({ path, scope });
        if (scope) throw new ApiError(403, path, 'No access with account header');
        return { status: 'success', download_url: 'https://files.oaiusercontent.com/test/image' };
      },
    };
    const archive = new Archive(dir);
    const data = { message: { content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_image' }] } } };
    const assets = await saveAssets(api, archive, workspace, 'workspaces/test/conversations/chat_1', data,
      { conversationId: 'chat_1' });
    assert.equal(assets.missing.length, 0);
    assert.equal(await readFile(archive.path(assets.files[0]!.path), 'utf8'), 'image bytes');
    assert.deepEqual(seen.map(call => call.scope), ['account-1', null]);
  } finally {
    globalThis.fetch = realFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('sandbox download supports binary responses instead of assuming JSON descriptors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-sandbox-'));
  try {
    const paths: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async () => { throw new Error('Binary endpoint must not use JSON getter'); },
      openFile: async path => { paths.push(path); return binary('name,number\nTaylor,4\n'); },
    };
    const archive = new Archive(dir);
    const data = { id: 'message_one', content: { parts: ['[CSV](sandbox:/mnt/data/result.csv)'] } };
    const assets = await saveAssets(api, archive, workspace, 'workspaces/test/conversations/chat_one', data,
      { conversationId: 'chat_one' });
    assert.equal(assets.missing.length, 0);
    assert.equal(assets.files.length, 1);
    assert.ok(paths[0]?.includes('/interpreter/download?'));
    assert.match(await readFile(archive.path(assets.files[0]!.path), 'utf8'), /Taylor,4/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('permanently inaccessible assets remain explicitly missing with sanitized route diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-unavailable-'));
  try {
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async () => ({ status: 'error', error_code: 'permission_error' }),
      openFile: async () => new Response('not found', { status: 404 }),
    };
    const archive = new Archive(dir);
    const result = await saveAssets(api, archive, workspace, 'workspaces/test/projects/g-p-x',
      {}, { projectId: 'g-p-x', projectFiles: [{ id: 'file_old', name: 'old.txt' }] });
    assert.equal(result.files.length, 0);
    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0]!.reason, /No accessible download/);
    assert.ok((result.missing[0]!.attempts?.length ?? 0) >= 3);
    assert.ok(result.missing[0]!.attempts?.every(item => !item.reason.includes('file_old')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('untrusted signed URL hosts are still blocked', () => {
  for (const url of ['http://chatgpt.com/file', 'http://127.0.0.1/file',
    'https://evil.com/file', 'https://chatgpt.com.evil.com/x']) {
    assert.throws(() => safeDownloadUrl(url), /Untrusted signed asset host/);
  }
});
