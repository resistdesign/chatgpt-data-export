import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ElectronSessionClient, validateApiPath, type AuthenticatedSession } from './electron-client.js';
import { ApiError } from './errors.js';

const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('API client obtains short-lived bearer token through its session, not Chrome', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const session: AuthenticatedSession = { async fetch(url, init) {
    requests.push({ url, init });
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'ephemeral-token' });
    return json({ items: [1] });
  } };
  const client = new ElectronSessionClient(session, 250);
  assert.equal(await client.authenticated(), true);
  assert.deepEqual(await client.get('/backend-api/conversations?limit=1', 'workspace-1'), { items: [1] });
  assert.equal(requests.length, 2);
  assert.equal(new Headers(requests[1]?.init?.headers).get('authorization'), 'Bearer ephemeral-token');
  assert.equal(new Headers(requests[1]?.init?.headers).get('ChatGPT-Account-Id'), 'workspace-1');
  assert.equal(requests[1]?.init?.credentials, 'include');
});

test('unknown session is not treated as a successful sign-in', async () => {
  const session: AuthenticatedSession = { async fetch() { return json({}); } };
  const client = new ElectronSessionClient(session, 250);
  assert.equal(await client.authenticated(), false);
  await assert.rejects(client.get('/backend-api/conversations'), error => error instanceof ApiError && error.status === 401);
});

test('API client refuses external or malformed paths', () => {
  for (const path of ['https://evil.example/steal', '//evil.example', '/api/auth/session', '/backend-api/../logout', '/backend-api/foo#fragment']) {
    assert.throws(() => validateApiPath(path), /Invalid ChatGPT API path|escaped/);
  }
  assert.equal(validateApiPath('/backend-api/conversations?offset=3'), 'https://chatgpt.com/backend-api/conversations?offset=3');
});

test('cancelled API client retains local checkpoint authority and does not send requests', async () => {
  let requests = 0;
  const session: AuthenticatedSession = { async fetch(url) { requests++; return url.includes('/api/auth/session') ? json({ accessToken: 'token' }) : json({}); } };
  const client = new ElectronSessionClient(session, 250);
  await client.authenticated();
  client.cancel();
  await assert.rejects(client.get('/backend-api/conversations'), /cancelled/);
  assert.equal(requests, 1);
});

test('unauthorized scope is reported as a real API error, not a successful empty export', async () => {
  const session: AuthenticatedSession = { async fetch(url) {
    return url.includes('/api/auth/session') ? json({ accessToken: 'token' }) : json({ message: 'Forbidden' }, 403);
  } };
  const client = new ElectronSessionClient(session, 250);
  await client.authenticated();
  await assert.rejects(client.get('/backend-api/conversations'), error => error instanceof ApiError && error.status === 403);
});
