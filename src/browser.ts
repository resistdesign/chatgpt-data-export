import { chromium, type Browser, type Page } from 'playwright-core';
import type { Progress } from './progress.js';

const ORIGIN = 'https://chatgpt.com';
const CHROME_CHANNEL = 'chrome';
const CONNECT_TIMEOUT_MS = 60_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class ApiError extends Error {
  constructor(readonly status: number, readonly endpoint: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
export class RateLimitExhausted extends Error {
  constructor(readonly endpoint: string) { super('ChatGPT rate limits did not clear after retries; stop and resume later.'); }
}

interface BrowserResult { status: number; body: unknown; retryAfter: string | null }
type ChromeConnector = (endpoint: string, options: { timeout: number }) => Promise<Browser>;

/**
 * Attach to the user's EXISTING Chrome session via Chrome 144+ opt-in remote debugging.
 * Never launch Chrome, create a profile or tab, or navigate an existing tab.
 * Browser.close() on a CDP-attached browser disconnects Playwright without quitting Chrome.
 */
export class ChatGptBrowser {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private token: string | undefined;
  private nextAt = 0;
  private cooldownUntil = 0;
  private gap: number;
  private readonly initialGap: number;
  private halted = false;

  constructor(
    delayMs: number,
    private readonly progress: Progress,
    private readonly connect: ChromeConnector = (endpoint, options) => chromium.connectOverCDP(endpoint, options),
  ) {
    this.gap = delayMs;
    this.initialGap = delayMs;
  }

  async open(): Promise<void> {
    this.progress.info('Connecting to your existing Chrome session. Approve the debugging connection in Chrome if prompted.');
    try {
      this.browser = await this.connect(CHROME_CHANNEL, { timeout: CONNECT_TIMEOUT_MS });
    } catch {
      throw new Error(
        'Cannot connect to your existing Chrome. In Chrome (144+), open chrome://inspect/#remote-debugging, '
        + 'enable "Allow remote debugging for this browser instance", and run the CLI again. '
        + 'Approve the connection prompt in Chrome. No new profile or browser window is needed.',
      );
    }
    try {
      const pages = this.browser.contexts().flatMap(context => context.pages());
      const chatPages = pages.filter(page => {
        let isChatGpt = false;
        try { isChatGpt = new URL(page.url()).origin === ORIGIN; }
        catch { isChatGpt = false; }
        return isChatGpt;
      });
      if (!chatPages.length) {
        throw new Error('No ChatGPT tab found in the connected Chrome profile. Open https://chatgpt.com in your existing Chrome and run the CLI again.');
      }
      for (const page of chatPages) {
        this.page = page;
        this.token = await this.sessionToken();
        if (this.token) break;
      }
      if (!this.token) {
        throw new Error('Your existing Chrome tabs are not signed in to ChatGPT. Sign in normally in Chrome and rerun the CLI.');
      }
      this.progress.info('Authenticated using an existing ChatGPT tab. No new window, profile or tab was opened.');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private async sessionToken(): Promise<string | undefined> {
    let token: string | undefined;
    try {
      token = await this.page!.evaluate(async () => {
        const response = await fetch('/api/auth/session', { credentials: 'include' });
        if (!response.ok) return undefined;
        const session: unknown = await response.json();
        const value = (session as { accessToken?: unknown })?.accessToken;
        return typeof value === 'string' && value.length > 0 ? value : undefined;
      });
    } catch { token = undefined; }
    return token;
  }

  /** Disconnect from Chrome. Chrome itself and all of its tabs remain open. */
  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    this.page = undefined;
    this.token = undefined;
    if (browser) await browser.close();
  }

  cancel(): void { this.halted = true; }

  private async pace(): Promise<void> {
    if (this.halted) throw new Error('Export canceled by user. All completed files are retained.');
    const due = Math.max(Date.now(), this.nextAt, this.cooldownUntil);
    this.nextAt = due + this.gap;
    let remaining = due - Date.now();
    while (remaining > 0) {
      if (this.halted) throw new Error('Export canceled by user.');
      this.progress.set('Waiting', undefined, undefined, `next API request in ${Math.ceil(remaining / 1000)}s`);
      await sleep(Math.min(1000, remaining));
      remaining = due - Date.now();
    }
  }

  /** Only relative ChatGPT API paths are allowed. Never accept arbitrary target URLs. */
  async get(path: string, workspaceId: string | null = null): Promise<unknown> {
    if (!(path.startsWith('/backend-api/') || path.startsWith('/public-api/')) || path.includes('..') || path.includes('\\')) throw new Error('Invalid ChatGPT API path');
    for (let attempt = 0; attempt <= 6; attempt++) {
      await this.pace();
      const response = await this.request(path, workspaceId);
      if (response.status === 200) {
        if (this.gap > this.initialGap) this.gap = Math.max(this.initialGap, Math.floor(this.gap * 0.95));
        return response.body;
      }
      if (response.status === 401 && attempt < 6) {
        this.token = await this.sessionToken();
        if (!this.token) throw new ApiError(401, path, 'Session expired. Sign into your existing ChatGPT tab again, then resume.');
        continue;
      }
      const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
      if (!retryable) throw new ApiError(response.status, path, `ChatGPT returned HTTP ${response.status}`);
      if (attempt === 6) {
        if (response.status === 429) throw new RateLimitExhausted(path);
        throw new ApiError(response.status, path, `HTTP ${response.status} after 7 attempts`);
      }
      const serverSeconds = Number(response.retryAfter);
      const serverDelay = Number.isFinite(serverSeconds) && serverSeconds > 0 ? Math.min(300_000, serverSeconds * 1000) : 0;
      const delay = response.status === 429 ? Math.max(serverDelay, Math.min(120_000, 15_000 * 2 ** attempt)) : Math.min(30_000, 1000 * 2 ** attempt);
      if (response.status === 429) this.gap = Math.min(16_000, Math.max(this.gap * 2, 1000));
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
      this.progress.info(`HTTP ${response.status} from ChatGPT. Retry ${attempt + 1}/6 after ${Math.ceil(delay / 1000)}s; pacing ${this.gap}ms.`);
    }
    throw new Error('Unreachable retry state');
  }

  private async request(path: string, workspaceId: string | null): Promise<BrowserResult> {
    if (!this.page || !this.token) throw new Error('ChatGPT browser is not authenticated');
    try {
      return await this.page.evaluate(async ({ path, workspaceId, token }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120_000);
        try {
          const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
          if (workspaceId) headers['ChatGPT-Account-Id'] = workspaceId;
          const response = await fetch(path, { method: 'GET', credentials: 'include', headers, signal: controller.signal });
          const text = await response.text();
          if (text.length > 120_000_000) throw new Error('API response exceeds size limit');
          let body: unknown = null;
          if (text) { try { body = JSON.parse(text); } catch { body = { nonJson: true }; } }
          return { status: response.status, body, retryAfter: response.headers.get('Retry-After') };
        } finally { clearTimeout(timer); }
      }, { path, workspaceId, token: this.token });
    } catch (error) {
      this.progress.info(`Browser request failed: ${String(error).slice(0, 160)}`);
      return { status: 503, body: null, retryAfter: null };
    }
  }
}
