import test from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright-core';
import type { Progress } from './progress.js';
import { ChatGptBrowser } from './browser.js';

function progress(): Progress {
  return { info() {}, set() {} } as unknown as Progress;
}

function fakeBrowser(pages: Page[], state: { closed: boolean }): Browser {
  return {
    contexts: () => [{ pages: () => pages }],
    close: async () => { state.closed = true; },
  } as unknown as Browser;
}

function page(url: string, token?: string): Page {
  return {
    url: () => url,
    evaluate: async (_callback: unknown, params?: unknown) => params
      ? { status: 200, body: { ok: true }, retryAfter: null }
      : token,
  } as unknown as Page;
}

test('attaches to an existing ChatGPT tab without opening or navigating anything', async () => {
  const state = { closed: false };
  let connectionCount = 0;
  const browser = fakeBrowser([
    page('https://example.com'),
    page('https://chatgpt.com/c/signed-in', 'test-token'),
  ], state);
  const client = new ChatGptBrowser(250, progress(), async (endpoint, options) => {
    connectionCount++;
    assert.equal(endpoint, 'chrome');
    assert.equal(options.timeout, 60_000);
    return browser;
  });
  await client.open();
  assert.deepEqual(await client.get('/backend-api/example'), { ok: true });
  await client.close();
  assert.equal(connectionCount, 1);
  assert.equal(state.closed, true);
});

test('prefers a signed-in tab when another ChatGPT tab has no session', async () => {
  const state = { closed: false };
  const client = new ChatGptBrowser(250, progress(), async () => fakeBrowser([
    page('https://chatgpt.com/c/signed-out'),
    page('https://chatgpt.com/c/signed-in', 'test-token'),
  ], state));
  await client.open();
  await client.close();
  assert.equal(state.closed, true);
});

test('does not create a ChatGPT tab when none exists and disconnects on failure', async () => {
  const state = { closed: false };
  const client = new ChatGptBrowser(250, progress(), async () => fakeBrowser([
    page('https://other.example.com'),
  ], state));
  await assert.rejects(client.open(), /No ChatGPT tab found/);
  assert.equal(state.closed, true);
});

test('explains how to opt into connecting the current Chrome browser', async () => {
  const client = new ChatGptBrowser(250, progress(), async () => { throw new Error('No debug port'); });
  await assert.rejects(client.open(), /chrome:\/\/inspect\/#remote-debugging/);
});
