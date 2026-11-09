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
        // An observed route can fail for one account; retain the legacy fallback.
        if (path.includes('download_intent=')) return new Response('denied', { status: 403 });
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
    assert.ok(calls[0]!.path.includes('download_intent=true'));
    assert.ok(calls[0]!.path.includes('inline=false'));
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

test('current conversation-scoped endpoint downloads directly and avoids older routes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-current-asset-'));
  try {
    const routes: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => { routes.push(path); throw new Error('Legacy route unexpectedly called'); },
      openFile: async (path, scope) => {
        routes.push(path);
        assert.equal(scope, 'account-1');
        return binary('scoped attachment bytes');
      },
    };
    const data = { message: { content: { parts: [{
      content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_scoped_asset',
    }] } } };
    const archive = new Archive(dir);
    const result = await saveAssets(api, archive, workspace, 'workspaces/test/conversations/chat_one',
      data, { conversationId: 'chat_one' });
    assert.equal(result.missing.length, 0);
    assert.equal(result.files.length, 1);
    assert.deepEqual(routes, [
      '/backend-api/files/download/file_scoped_asset?check_context_scopes_for_conversation_id=chat_one&download_intent=true',
    ]);
    assert.equal(await readFile(archive.path(result.files[0]!.path), 'utf8'), 'scoped attachment bytes');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('current conversation-scoped failure falls back to the older signed-link route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-current-fallback-'));
  const routes: string[] = [];
  try {
    const api: ChatGptApi = {
      cancel: () => undefined,
      openFile: async path => {
        routes.push(path);
        return new Response('file not found', { status: 404 });
      },
      get: async path => {
        routes.push(path);
        // The old JSON endpoint can still be supported on some accounts.
        return { status: 'success', download_url: '/backend-api/estuary/content?id=file_test' };
      },
    };
    // Mock the authenticated binary response from the signed ChatGPT URL.
    api.openFile = async path => {
      routes.push(path);
      return path.startsWith('/backend-api/estuary/') ? binary('signed link bytes')
        : new Response('file not found', { status: 404 });
    };
    const data = { message: { content: { parts: [{
      content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_test',
    }] } } };
    const archive = new Archive(dir);
    const result = await saveAssets(api, archive, workspace, 'workspaces/test/conversations/chat_test',
      data, { conversationId: 'chat_test' });
    assert.equal(result.missing.length, 0);
    assert.equal(await readFile(archive.path(result.files[0]!.path), 'utf8'), 'signed link bytes');
    assert.ok(routes[0]?.includes('check_context_scopes_for_conversation_id=chat_test'));
    assert.ok(routes.some(route => route.includes('conversation_id=chat_test&inline=false')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('successful observed Project route saves signed estuary file bytes, not JSON metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-live-project-'));
  try {
    const paths: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => { throw new Error('Legacy route unexpectedly called: ' + path); },
      openFile: async path => {
        paths.push(path);
        if (path.startsWith('/backend-api/estuary/content')) return binary('real Project attachment bytes');
        if (path.startsWith('/backend-api/files/download/file_project_new?')) {
          return new Response(JSON.stringify({
            status: 'success',
            download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_project_new&sig=REDACTED',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error('Unexpected file path');
      },
    };
    const archive = new Archive(dir);
    const result = await saveAssets(api, archive, workspace, 'workspaces/test/projects/g-p-abc', {}, {
      projectId: 'g-p-abc', projectFiles: [{ file_id: 'file_project_new', name: 'filename.txt' }],
    });
    assert.equal(result.missing.length, 0);
    assert.equal(result.files.length, 1);
    assert.equal(await readFile(archive.path(result.files[0]!.path), 'utf8'), 'real Project attachment bytes');
    assert.equal(await archive.verified(result.files[0]!), true);
    const parsed = new URL(paths[0]!, 'https://chatgpt.com');
    assert.equal(parsed.pathname, '/backend-api/files/download/file_project_new');
    assert.equal(parsed.searchParams.get('gizmo_id'), 'g-p-abc');
    assert.equal(parsed.searchParams.get('download_intent'), 'true');
    assert.equal(parsed.searchParams.get('inline'), 'false');
    assert.equal(paths.length, 2, 'no legacy fallbacks needed when the observed route works');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('conversation inside a Project uses BOTH context IDs, then simple metadata route if necessary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cde-project-chat-'));
  try {
    const paths: string[] = [];
    const api: ChatGptApi = {
      cancel: () => undefined,
      get: async path => { throw new Error('Unexpected JSON API request: ' + path); },
      openFile: async path => {
        paths.push(path);
        if (path.startsWith('/backend-api/files/download/')) return new Response('not found', { status: 404 });
        if (path.includes('/simple?')) return new Response(JSON.stringify({
          status: 'success',
          file: { download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_in_project' },
        }), { headers: { 'content-type': 'application/json' } });
        if (path.startsWith('/backend-api/estuary/content')) return binary('conversation attachment bytes');
        throw new Error('Unexpected path');
      },
    };
    const raw = { message: { content: { parts: [{
      content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_in_project',
    }] } } };
    const archive = new Archive(dir);
    const result = await saveAssets(api, archive, workspace, 'workspaces/test/conversations/chat_yes', raw, {
      conversationId: 'chat_yes', projectId: 'g-p-abc',
    });
    assert.equal(result.missing.length, 0);
    assert.equal(await readFile(archive.path(result.files[0]!.path), 'utf8'), 'conversation attachment bytes');
    const first = new URL(paths[0]!, 'https://chatgpt.com');
    assert.equal(first.searchParams.get('check_context_scopes_for_conversation_id'), 'chat_yes');
    assert.equal(first.searchParams.get('gizmo_id'), 'g-p-abc');
    assert.equal(first.searchParams.get('download_intent'), 'true');
    const simple = new URL(paths.find(path => path.includes('/simple?'))!, 'https://chatgpt.com');
    assert.equal(simple.searchParams.get('conversation_id'), 'chat_yes');
    assert.equal(simple.searchParams.get('gizmo_id'), 'g-p-abc');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
