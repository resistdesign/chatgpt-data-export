import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ElectronSessionClient, retryAfterMs, validateApiPath, type AuthenticatedSession, type RequestTiming } from './electron-client.js';
import { ApiError, ResourceDeniedError, SessionExpiredError, SessionCheckError, ExportCancelledError } from './errors.js';
import { Progress } from './progress.js';

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


test('Retry-After accepts seconds and HTTP dates, bounds malformed or extreme hints', () => {
  const now = Date.parse('2026-11-09T08:00:00.000Z');
  assert.equal(retryAfterMs('45', now), 45_000);
  assert.equal(retryAfterMs('Mon, 09 Nov 2026 08:02:00 GMT', now), 120_000);
  assert.equal(retryAfterMs('Mon, 09 Nov 2026 07:00:00 GMT', now), 0);
  assert.equal(retryAfterMs('999999999', now), 60 * 60_000);
  assert.equal(retryAfterMs('bogus', now), 0);
  assert.equal(retryAfterMs(null, now), 0);
});

test('consecutive 429 responses use longer global cooldowns and honor server Retry-After', async () => {
  let now = 0;
  const timestamps: number[] = [];
  const waits: string[] = [];
  const timing: RequestTiming = {
    now: () => now, sleep: async ms => { now += ms; }, random: () => 0,
  };
  let requests = 0;
  const session: AuthenticatedSession = { async fetch(url) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'token' });
    timestamps.push(now);
    requests++;
    if (requests === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '45' } });
    if (requests === 2) return new Response('{}', { status: 429 });
    return json({ ok: true });
  } };
  const progress = new Progress(snapshot => {
    if (snapshot.waiting) waits.push(snapshot.waiting);
  }, false);
  const client = new ElectronSessionClient(session, 1000, progress, timing);
  await client.authenticated();
  assert.deepEqual(await client.get('/backend-api/conversations/chat_one'), { ok: true });
  assert.deepEqual(timestamps, [0, 45_000, 105_000],
    'first 429 obeys server 45s; second response extends shared pause by 60s');
  assert.ok(waits.some(message => message.includes('Rate-limit pause')),
    'rate-limit waits should have a distinct label');
});

test('a second worker rechecks shared cooldown after it starts waiting', async () => {
  let now = 0;
  let releaseFirstWait: (() => void) | undefined;
  let announceWaiting!: () => void;
  const waiting = new Promise<void>(resolve => { announceWaiting = resolve; });
  let announceThrottle!: () => void;
  const throttled = new Promise<void>(resolve => { announceThrottle = resolve; });
  let firstSleep = true;
  const timing: RequestTiming = {
    now: () => now, random: () => 0,
    sleep: async ms => {
      if (firstSleep) {
        firstSleep = false;
        announceWaiting();
        await new Promise<void>(resolve => { releaseFirstWait = resolve; });
      }
      now += ms;
    },
  };
  let completeFirstRequest!: () => void;
  const firstResponse = new Promise<Response>(resolve => {
    completeFirstRequest = () => resolve(new Response('{}', { status: 429 }));
  });
  const timestamps: Array<{ path: string; at: number }> = [];
  let firstA = true;
  const session: AuthenticatedSession = { async fetch(url) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'token' });
    const path = new URL(url).pathname;
    timestamps.push({ path, at: now });
    if (path.endsWith('/chat_a') && firstA) {
      firstA = false;
      return firstResponse;
    }
    return json({ ok: true });
  } };
  const progress = new Progress(snapshot => {
    if (snapshot.message?.includes('HTTP 429')) announceThrottle();
  }, false);
  const client = new ElectronSessionClient(session, 1000, progress, timing);
  await client.authenticated();
  const a = client.get('/backend-api/conversations/chat_a');
  const b = client.get('/backend-api/conversations/chat_b');
  await waiting;
  completeFirstRequest();
  await throttled;
  releaseFirstWait?.();
  await Promise.all([a, b]);
  const bRequest = timestamps.find(item => item.path.endsWith('/chat_b'));
  assert.ok(bRequest);
  assert.ok(bRequest.at >= 30_000,
    'second worker must not use the 1s admission deadline calculated before the first 429');
});

test('cancellation interrupts a shared backoff without any more file requests', async () => {
  let now = 0;
  let releaseWait!: () => void;
  let signalWait!: () => void;
  const waitStarted = new Promise<void>(resolve => { signalWait = resolve; });
  let paused = false;
  const timing: RequestTiming = {
    now: () => now, random: () => 0,
    sleep: async ms => {
      if (!paused) {
        paused = true;
        signalWait();
        await new Promise<void>(resolve => { releaseWait = resolve; });
      }
      now += ms;
    },
  };
  let requests = 0;
  const session: AuthenticatedSession = { async fetch(url) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'token' });
    requests++;
    return new Response('{}', { status: 429 });
  } };
  const client = new ElectronSessionClient(session, 1000, undefined, timing);
  await client.authenticated();
  const attempt = client.get('/backend-api/conversations/chat_one');
  await waitStarted;
  client.cancel();
  releaseWait();
  await assert.rejects(attempt, error => error instanceof ExportCancelledError);
  assert.equal(requests, 1, 'cancelled request must not retry after the rate-limit pause');
});

test('binary attachment HTTP 429 shares adaptive cooldown and honors Retry-After', async () => {
  let now = 0;
  const sentAt: number[] = [];
  const waits: string[] = [];
  const timing: RequestTiming = {
    now: () => now, sleep: async ms => { now += ms; }, random: () => 0,
  };
  const session: AuthenticatedSession = { async fetch(url, init) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'token' });
    sentAt.push(now);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token');
    if (sentAt.length === 1) {
      return new Response('{}', { status: 429, headers: { 'Retry-After': '75' } });
    }
    return new Response('binary bytes', { status: 200 });
  } };
  const client = new ElectronSessionClient(session, 750, new Progress(snapshot => {
    if (snapshot.waiting) waits.push(snapshot.waiting);
  }, false), timing);
  await client.authenticated();
  const response = await client.openFile('/backend-api/files/download/file_test');
  assert.equal(await response.text(), 'binary bytes');
  assert.deepEqual(sentAt, [0, 75_000]);
  assert.ok(waits.some(message => message.includes('Rate-limit pause')),
    'binary file requests must respect the same shared HTTP 429 pause');
});

test('binary asset returns a resource 403 immediately, without rate-limit retry', async () => {
  let calls = 0;
  const session: AuthenticatedSession = { async fetch(url) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'token' });
    calls++;
    return new Response('denied', { status: 403 });
  } };
  const client = new ElectronSessionClient(session, 750);
  await client.authenticated();
  const response = await client.openFile('/backend-api/files/download/file_denied');
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
});

test('repeat file-level 401 responses reuse a briefly confirmed healthy session', async () => {
  let now = 0;
  let accountChecks = 0;
  let deniedFiles = 0;
  const timing: RequestTiming = {
    now: () => now, sleep: async ms => { now += ms; }, random: () => 0,
  };
  const session: AuthenticatedSession = { async fetch(url) {
    if (url.endsWith('/api/auth/session')) return json({ accessToken: 'same-valid-token' });
    if (url.includes('/backend-api/accounts/check')) {
      accountChecks++;
      return json({ accounts: { personal: {} } });
    }
    deniedFiles++;
    return json({ error: 'file unavailable for this session' }, 401);
  } };
  const client = new ElectronSessionClient(session, 250, undefined, timing);
  await client.authenticated();
  await assert.rejects(client.openFile('/backend-api/files/download/file_one'), error => error instanceof ResourceDeniedError);
  await assert.rejects(client.openFile('/backend-api/files/download/file_two'), error => error instanceof ResourceDeniedError);
  await assert.rejects(client.get('/backend-api/files/download/file_three'), error => error instanceof ResourceDeniedError);
  assert.equal(deniedFiles, 3, 'each file is tried only once');
  assert.equal(accountChecks, 1, 'the same healthy token is confirmed only once within twenty seconds');
  now += 21_000;
  await assert.rejects(client.openFile('/backend-api/files/download/file_four'), error => error instanceof ResourceDeniedError);
  assert.equal(accountChecks, 2, 'an elapsed health-cache window forces revalidation');
});
