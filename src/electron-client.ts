import { ApiError, RateLimitExhausted } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import type { Progress } from './progress.js';

/** The Electron Session.fetch contract, reduced to something mockable in tests. */
export interface AuthenticatedSession {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const ORIGIN = 'https://chatgpt.com';
const timeout = 120_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export function validateApiPath(path: string): string {
  if (!(path.startsWith('/backend-api/') || path.startsWith('/public-api/')) || path.includes('..') || path.includes('\\') || path.includes('#')) {
    throw new Error('Invalid ChatGPT API path');
  }
  const url = new URL(path, ORIGIN);
  if (url.origin !== ORIGIN) throw new Error('ChatGPT API path escaped the origin');
  return url.toString();
}

export interface FetchReply { status: number; body: unknown; retryAfter: string | null }

/** Uses Electron's own persistent session, never Chrome cookies or a debugging port. */
export class ElectronSessionClient implements ChatGptApi {
  private token: string | undefined;
  private refresh: Promise<string | undefined> | undefined;
  private nextAt = 0;
  private cooldownUntil = 0;
  private gap: number;
  private readonly initialGap: number;
  private halted = false;
  private pacing = Promise.resolve();

  constructor(private readonly session: AuthenticatedSession, delayMs = 750, private readonly progress?: Progress) {
    this.gap = delayMs;
    this.initialGap = delayMs;
  }

  async authenticated(): Promise<boolean> {
    this.token = await this.sessionToken();
    return Boolean(this.token);
  }

  private sessionToken(): Promise<string | undefined> {
    if (!this.refresh) {
      const pending = (async () => {
        try {
          const response = await this.session.fetch(`${ORIGIN}/api/auth/session`, {
            method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'manual',
            headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) return undefined;
          const data: unknown = await response.json();
          const value = (data as { accessToken?: unknown } | null)?.accessToken;
          return typeof value === 'string' && value.length ? value : undefined;
        } catch { return undefined; }
      })();
      this.refresh = pending;
      void pending.finally(() => { if (this.refresh === pending) this.refresh = undefined; });
    }
    return this.refresh;
  }

  cancel(): void { this.halted = true; }

  /** Serialized admission to the network; admitted requests can execute concurrently. */
  private async pace(): Promise<void> {
    const previous = this.pacing;
    let release!: () => void;
    this.pacing = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (this.halted) throw new Error('Export cancelled. Saved checkpoints are retained.');
      const due = Math.max(Date.now(), this.nextAt, this.cooldownUntil);
      this.nextAt = due + this.gap;
      while (Date.now() < due) {
        if (this.halted) throw new Error('Export cancelled. Saved checkpoints are retained.');
        const seconds = Math.ceil((due - Date.now()) / 1000);
        this.progress?.waiting(`cooldown: next request in ${seconds}s`);
        await sleep(Math.min(750, due - Date.now()));
      }
    } finally { release(); }
  }

  async get(path: string, workspaceId: string | null = null): Promise<unknown> {
    const url = validateApiPath(path);
    if (!this.token) this.token = await this.sessionToken();
    if (!this.token) throw new ApiError(401, path, 'Sign in to ChatGPT in the application, then resume.');
    for (let attempt = 0; attempt <= 6; attempt++) {
      await this.pace();
      const response = await this.request(url, workspaceId, this.token);
      if (response.status === 200) {
        this.gap = Math.max(this.initialGap, Math.floor(this.gap * 0.95));
        return response.body;
      }
      if (response.status === 401) {
        this.token = await this.sessionToken();
        if (!this.token) throw new ApiError(401, path, 'ChatGPT session expired. Sign in again in the application.');
        if (attempt < 6) continue;
      }
      const retryable = [408, 429].includes(response.status) || response.status >= 500;
      if (!retryable) throw new ApiError(response.status, path, `ChatGPT returned HTTP ${response.status}`);
      if (attempt === 6) {
        if (response.status === 429) throw new RateLimitExhausted(path);
        throw new ApiError(response.status, path, `HTTP ${response.status} after 7 attempts`);
      }
      const retryHeader = response.retryAfter;
      const parsed = retryHeader ? Number(retryHeader) : NaN;
      const retryAt = retryHeader && !Number.isFinite(parsed) ? Date.parse(retryHeader) : NaN;
      const serverWait = Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
      const delay = response.status === 429 ? Math.max(serverWait, Math.min(120_000, 15_000 * (2 ** attempt))) : Math.min(30_000, 1000 * (2 ** attempt));
      if (response.status === 429) this.gap = Math.min(16_000, Math.max(this.gap * 2, 1000));
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + Math.min(300_000, delay));
      this.progress?.info(`ChatGPT HTTP ${response.status}; retry ${attempt + 1}/6 after ${Math.ceil(delay / 1000)}s (pacing ${this.gap}ms).`);
    }
    throw new Error('Unreachable retry state');
  }

  private async request(url: string, workspaceId: string | null, token: string): Promise<FetchReply> {
    try {
      const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${token}` };
      if (workspaceId) headers['ChatGPT-Account-Id'] = workspaceId;
      const response = await this.session.fetch(url, {
        method: 'GET', headers, credentials: 'include', cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(timeout),
      });
      if (response.status >= 300 && response.status < 400) return { status: 401, body: null, retryAfter: null };
      const contentLength = Number(response.headers.get('content-length'));
      if (contentLength > 120_000_000) throw new Error('ChatGPT response exceeds 120 MB limit');
      const raw = await response.text();
      if (raw.length > 120_000_000) throw new Error('ChatGPT response exceeds 120 MB limit');
      let body: unknown = null;
      if (raw.length) { try { body = JSON.parse(raw) as unknown; } catch { body = { nonJson: true }; } }
      return { status: response.status, body, retryAfter: response.headers.get('Retry-After') };
    } catch (error) {
      if (this.halted) throw new Error('Export cancelled. Saved checkpoints are retained.');
      this.progress?.info(`ChatGPT request interrupted: ${error instanceof Error ? error.name : 'network error'}. Retrying if possible.`);
      return { status: 503, body: null, retryAfter: null };
    }
  }
}
