import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ElectronSessionClient, validateApiPath, type AuthenticatedSession } from './electron-client.js';
import { ApiError, ResourceDeniedError, SessionExpiredError, SessionCheckError } from './errors.js';

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

test('401 for one resource is not mistaken for an expired login or retried repeatedly', async () => {
  let resourceRequests = 0;
  let accountChecks = 0;
  const session: AuthenticatedSession = { async fetch(url) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'valid-token' });
    if (url.includes('/backend-api/accounts/check')) {
      accountChecks++;
      return json({ accounts: { personal: {} } });
    }
    resourceRequests++;
    return json({ message: 'Not authorized for this conversation' }, 401);
  } };
  const client = new ElectronSessionClient(session, 250);
  assert.equal(await client.authenticated(), true);
  await assert.rejects(client.get('/backend-api/conversations/chat_restricted'),
    error => error instanceof ResourceDeniedError && error.status === 401);
  assert.equal(resourceRequests, 1, 'do not retry a known-unchanged token seven times');
  assert.equal(accountChecks, 1, 'verify that the account is still signed in');
});

test('a refreshed bearer token recovers a stale session automatically', async () => {
  let sessionReads = 0;
  const session: AuthenticatedSession = { async fetch(url, init) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: ++sessionReads === 1 ? 'stale-token' : 'fresh-token' });
    const auth = new Headers(init?.headers).get('authorization');
    return auth === 'Bearer fresh-token' ? json({ items: ['recovered'] }) : json({ error: 'stale' }, 401);
  } };
  const client = new ElectronSessionClient(session, 250);
  assert.equal(await client.authenticated(), true);
  assert.deepEqual(await client.get('/backend-api/conversations/chat_1'), { items: ['recovered'] });
  assert.equal(sessionReads, 2);
});

test('expired global session interrupts instead of converting thousands of chats into failures', async () => {
  const session: AuthenticatedSession = { async fetch(url) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'expired-token' });
    return json({ error: 'unauthorized' }, 401);
  } };
  const client = new ElectronSessionClient(session, 250);
  await client.authenticated();
  await assert.rejects(client.get('/backend-api/conversations/chat_1'),
    error => error instanceof SessionExpiredError && error.status === 401);
});

test('inconclusive account authentication check stops rather than silently losing conversations', async () => {
  const session: AuthenticatedSession = { async fetch(url) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'token' });
    if (url.includes('/backend-api/accounts/check')) return json({ message: 'overloaded' }, 503);
    return json({ error: 'unauthorized' }, 401);
  } };
  const client = new ElectronSessionClient(session, 250);
  await client.authenticated();
  await assert.rejects(client.get('/backend-api/conversations/chat_1'),
    error => error instanceof SessionCheckError && error.status === 503);
});

test('binary asset 401 checks account scope before declaring a login expired', async () => {
  const paths: string[] = [];
  const session: AuthenticatedSession = { async fetch(url, init) {
    paths.push(url);
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'valid-token' });
    if (url.includes('/backend-api/accounts/check')) return json({ accounts: { business: {} } });
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer valid-token');
    assert.equal(new Headers(init?.headers).get('ChatGPT-Account-Id'), 'account-1');
    return json({ error: 'no access' }, 401);
  } };
  const client = new ElectronSessionClient(session, 250);
  await client.authenticated();
  await assert.rejects(client.openFile('/backend-api/files/file_one/download', 'account-1'),
    error => error instanceof ResourceDeniedError && error.status === 401);
  assert.equal(paths.filter(x => x.includes('/backend-api/files/')).length, 1);
});

test('binary asset request never follows a redirected token to another origin', async () => {
  const session: AuthenticatedSession = { async fetch(url, init) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'valid-token' });
    assert.equal(init?.redirect, 'manual');
    return new Response(null, {
      status: 302, headers: { Location: 'https://files.oaiusercontent.com/signed-asset' },
    });
  } };
  const client = new ElectronSessionClient(session, 250);
  await client.authenticated();
  const response = await client.openFile('/backend-api/files/file_one/download', 'account-1');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), 'https://files.oaiusercontent.com/signed-asset');
});
