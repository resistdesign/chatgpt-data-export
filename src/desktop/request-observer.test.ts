import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeFileRequest, formatObservedRequests, safeRequestHeaderNames, matchesMissingProjectFile } from './request-observer.js';

test('sanitizes real-looking project download route and removes all values', () => {
  const fileId = 'file_PRIVATE_CUSTOMER_NOTES';
  const projectId = 'g-p-PRIVATE_PROJECT';
  const token = 'SECRET';
  const observed = summarizeFileRequest(
    `https://chatgpt.com/backend-api/files/download/${fileId}?gizmo_id=${projectId}&download_intent=true&secret_key=${token}`, 200,
  );
  assert.deepEqual(observed, {
    route: '/backend-api/files/download/{file-id}', method: 'GET',
    queryKeys: ['download_intent', 'gizmo_id'], otherQueryKeys: 1, status: 'HTTP 200',
    booleans: { download_intent: true },
  });
  const summary = formatObservedRequests([observed!]).join('\n');
  assert.doesNotMatch(summary, /PRIVATE|SECRET|secret_key|true/);
  assert.match(summary, /HTTP 200/);
});

test('observes project-specific and conversation-scoped API shapes but ignores chat content', () => {
  const gizmo = summarizeFileRequest('https://chatgpt.com/backend-api/gizmos/g-p-CUSTOMER/files?file_id=PRIVATE', 403);
  assert.equal(gizmo?.route, '/backend-api/gizmos/{project-id}/{file-route}');
  const conversation = summarizeFileRequest(
    'https://chatgpt.com/backend-api/conversations/PRIVATE/files?limit=200', 200,
  );
  assert.equal(conversation?.route, '/backend-api/conversation/{conversation-id}/{file-route}');
  assert.equal(summarizeFileRequest('https://chatgpt.com/backend-api/conversation/PRIVATE', 200), null);
  assert.equal(summarizeFileRequest('https://evil.com/backend-api/files/download/SECRET', 200), null);
  assert.equal(summarizeFileRequest('https://chatgpt.com/api/auth/session', 200), null);
  assert.equal(summarizeFileRequest('https://chatgpt.com/backend-api/gizmos/g-p-PRIVATE', 200), null);
});

test('signed estuary content URL retains only approved key names, no signatures', () => {
  const sample = 'https://chatgpt.com/backend-api/estuary/content?id=file_PRIVATE&sig=SECRET&ts=1234567&p=fs';
  const observed = summarizeFileRequest(sample, 302, 'GET');
  assert.equal(observed?.route, '/backend-api/estuary/content');
  assert.deepEqual(observed?.queryKeys, ['id']);
  assert.equal(observed?.otherQueryKeys, 3);
  assert.doesNotMatch(formatObservedRequests([observed!]).join(' '), /PRIVATE|SECRET|1234567/);
});

test('invalid URLs and unauthorized origins are ignored', () => {
  assert.equal(summarizeFileRequest('not a url', 404), null);
  assert.equal(summarizeFileRequest('http://chatgpt.com/backend-api/files/download/file_x', 200), null);
  assert.equal(summarizeFileRequest('https://chatgpt.com.evil.com/backend-api/files/download/file_x', 200), null);
  assert.equal(summarizeFileRequest('https://chatgpt.com/backend-api/files/download/file_x', 0)?.status, 'unknown');
});

test('safe boolean flags and header presence are observable but secret values never retained', () => {
  const headers = {
    Authorization: 'Bearer SECRET_TOKEN', 'ChatGPT-Account-ID': 'account_SECRET',
    Cookie: 'private=SECRET', 'X-Secret-Customer': 'SECRET',
    Accept: 'application/json',
  };
  const names = safeRequestHeaderNames(headers);
  assert.deepEqual(names, ['accept', 'authorization', 'chatgpt-account-id', 'cookie']);
  const observed = summarizeFileRequest(
    'https://chatgpt.com/backend-api/files/download/file_PRIVATE?' +
      'gizmo_id=g-p-PRIVATE&inline=true&download_intent=false&secret=HIDDEN',
    403, 'GET', names,
  );
  assert.deepEqual(observed?.booleans, { inline: true, download_intent: false });
  const summary = formatObservedRequests([observed!]).join('\n');
  assert.match(summary, /inline=true/);
  assert.match(summary, /download_intent=false/);
  assert.match(summary, /headers present: accept, authorization, chatgpt-account-id, cookie/);
  assert.doesNotMatch(summary, /SECRET|PRIVATE|HIDDEN|X-Secret-Customer|g-p-PRIVATE/);
});

test('invalid boolean flags and unrecognized header names are never copied', () => {
  const observed = summarizeFileRequest(
    'https://chatgpt.com/backend-api/files/download/file_PRIVATE?' +
    'inline=SECRET&download_intent=SECRET&signature=HIDDEN',
    200, 'GET', ['Authorization', 'x-secret-value', 'Cookie'],
  );
  assert.equal(observed?.booleans, undefined);
  const summary = formatObservedRequests([observed!]).join('\n');
  assert.doesNotMatch(summary, /SECRET|PRIVATE|HIDDEN|x-secret/);
  assert.match(summary, /headers present: authorization, cookie/);
});

test('browser observation compares the exact missing Project and file IDs privately', () => {
  const pair = 'g-p-SECRET' + '\0' + 'file_SECRET';
  const missing = new Set([pair]);
  const url = 'https://chatgpt.com/backend-api/files/download/file_SECRET?' +
    'download_intent=true&gizmo_id=g-p-SECRET&inline=false';
  const same = matchesMissingProjectFile(url, missing);
  const different = matchesMissingProjectFile(url.replace('file_SECRET', 'file_OTHER'), missing);
  const unrelated = matchesMissingProjectFile(
    'https://chatgpt.com/backend-api/conversation/SECRET', missing);
  assert.equal(same, true);
  assert.equal(different, false);
  assert.equal(unrelated, undefined);
  const summary = formatObservedRequests([{
    ...summarizeFileRequest(url, 200)!,
    matchesArchivedMissingProjectFile: same,
  }]).join('\n');
  assert.match(summary, /same missing Project file: YES/);
  assert.doesNotMatch(summary, /file_SECRET|g-p-SECRET/);
});
