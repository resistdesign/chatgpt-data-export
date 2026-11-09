import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import type { Progress } from './progress.js';

const ORIGIN = 'https://chatgpt.com';
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

/** Authenticated requests run on the ChatGPT origin. Tokens only live in process memory. */
export class ChatGptBrowser {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private token: string | undefined;
  private nextAt = 0;
  private cooldownUntil = 0;
  private gap: number;
  private readonly initialGap: number;
  private halted = false;

  constructor(private readonly profile: string, delayMs: number, private readonly progress: Progress) {
    this.gap = delayMs;
    this.initialGap = delayMs;
  }
  async open(): Promise<void> {
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    try {
      this.context = await chromium.launchPersistentContext(this.profile, { channel: 'chrome', headless: false, viewport: null });
    } catch (error) {
      throw new Error('Could not launch installed Google Chrome. Install Chrome and close any other exporter using this profile. ' + String(error));
    }
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    this.token = await this.sessionToken();
    if (!this.token) {
      this.progress.info('Sign in to ChatGPT in the newly opened Chrome window.');
      const reader = createInterface({ input: process.stdin, output: process.stdout });
      try { await reader.question('When signed in, press Enter here to continue: '); }
      finally { reader.close(); }
      this.token = await this.sessionToken();
    }
    if (!this.token) throw new Error('No active ChatGPT session. Sign in using the dedicated Chrome window and retry.');
    this.progress.info('Authenticated using the local Chrome profile (no token saved by this CLI).');
  }
  private async sessionToken(): Promise<string | undefined> {
    try {
      return await this.page!.evaluate(async () => {
        const response = await fetch('/api/auth/session', { credentials: 'include' });
        if (!response.ok) return undefined;
        const session: unknown = await response.json();
        const token = (session as { accessToken?: unknown })?.accessToken;
        return typeof token === 'string' && token.length > 0 ? token : undefined;
      });
    } catch { return undefined; }
  }
  async close(): Promise<void> { await this.context?.close(); this.page = undefined; this.token = undefined; }
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
  /** Only relative /backend-api/ paths are permitted. No caller-selected external URLs. */
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
        if (!this.token) throw new ApiError(401, path, 'Session expired. Sign into Chrome again, then resume.');
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
