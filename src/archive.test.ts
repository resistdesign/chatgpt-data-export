import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive, sha256, safeId, type CompletionMarker } from './archive.js';
import { collectAssets } from './discovery.js';
import { safeDownloadUrl } from './assets.js';

test('atomically saves records and resumes only hash-valid, unchanged conversations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-data-export-test-'));
  try {
    const archive = new Archive(dir);
    const root = 'workspaces/work/conversations/convo';
    const raw = await archive.json(`${root}/raw.json`, { id: 'convo', mapping: {} });
    const marker: CompletionMarker = { schema: 1, id: 'convo', updated: 123, raw, files: [], missing: [], completedAt: new Date().toISOString() };
    await archive.json(`${root}/complete.json`, marker);
    assert.equal(await archive.canSkip('work', 'convo', 123, true), true);
    assert.equal(await archive.canSkip('work', 'convo', 124, true), false);
    await archive.atomic(`${root}/raw.json`, '{"changed":true}');
    assert.equal(await archive.canSkip('work', 'convo', 123, true), false);
    assert.equal(sha256(await readFile(archive.path(`${root}/raw.json`))), await archive.fileHash(`${root}/raw.json`));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('partial asset markers are retried; archive paths reject traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-data-export-test-'));
  try {
    const archive = new Archive(dir);
    const raw = await archive.json('workspaces/work/conversations/test/raw.json', { id: 'test' });
    await archive.json('workspaces/work/conversations/test/complete.json', { schema: 1, id: 'test', updated: null, raw, files: [], missing: [{ id: 'file_bad', reason: '404' }], completedAt: '' });
    assert.equal(await archive.canSkip('work', 'test', null, true), false);
    assert.equal(await archive.canSkip('work', 'test', null, false), true);
    assert.throws(() => archive.path('../elsewhere'));
    assert.throws(() => safeId('../elsewhere'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('asset discovery handles upload attachments and generated pointers', () => {
  const refs = collectAssets({ mapping: { one: { message: { metadata: { attachments: [{ id: 'file_upload123', name: 'report.pdf' }] }, content: { parts: [{ asset_pointer: 'sediment://file_generated123' }] } } } } });
  assert.deepEqual(refs.map(r => r.id).sort(), ['file_generated123', 'file_upload123']);
});

test('signed asset download URLs reject insecure origins and local addresses', () => {
  assert.equal(safeDownloadUrl('https://files.oaiusercontent.com/a').hostname, 'files.oaiusercontent.com');
  assert.throws(() => safeDownloadUrl('http://files.oaiusercontent.com/a'));
  assert.throws(() => safeDownloadUrl('https://127.0.0.1/a'));
  assert.throws(() => safeDownloadUrl('https://oaiusercontent.com.attacker.example/a'));
});

test('recovers a valid stored conversation after interruption without waiting on API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-data-export-test-'));
  try {
    const archive = new Archive(dir);
    const root = 'workspaces/work/conversations/older';
    const raw = await archive.json(`${root}/raw.json`, { id: 'older', value: 'preserved' });
    await archive.json(`${root}/complete.json`, { schema: 1, id: 'older', updated: 'same', raw, files: [], missing: [], completedAt: '' });
    await archive.json('workspaces/work/inventory.json', { schema: 1, conversations: [{ id: 'older' }] });
    assert.deepEqual(await archive.verifyWorkspace('work'), { expected: 1, complete: 1, partial: 0, failed: [], otherMissing: ['workspaces/work/account/manifest.json'] });
    assert.equal(await archive.canSkip('work', 'older', 'same', true), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
