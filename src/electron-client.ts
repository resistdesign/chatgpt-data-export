import { ApiError, RateLimitExhausted, ResourceDeniedError, SessionExpiredError, SessionCheckError, ExportCancelledError } from './errors.js';
import type { ChatGptApi } from './api-types.js';
import type { Progress } from './progress.js';

/** The Electron Session.fetch contract, reduced to something mockable in tests. */
export interface AuthenticatedSession {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const ORIGIN = 'https://chatgpt.com';
const timeout = 120_000;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Injectable clock makes concurrency and multi-minute cooldowns testable instantly. */
export interface RequestTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}
const realTiming: RequestTiming = { now: () => Date.now(), sleep, random: () => Math.random() };
const MAX_RETRY_AFTER = 60 * 60_000;
const MAX_RATE_LIMIT_PAUSE = 5 * 60_000;

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_RETRY_AFTER, Math.ceil(seconds * 1000));
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER, Math.max(0, date - now)) : 0;
}

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
  private consecutive429s = 0;
  private successesSince429 = 0;
  private halted = false;
  private pacing = Promise.resolve();
  // Cache only a recently confirmed healthy token to avoid an extra account
  // request for every resource-level 401 in a long historical file archive.
  private healthyToken: string | undefined;
  private healthyUntil = 0;

  constructor(
    private readonly session: AuthenticatedSession,
    delayMs = 750,
    private readonly progress?: Progress,
    private readonly timing: RequestTiming = realTiming,
  ) {
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

  /**
   * Classify a resource-level HTTP 401 without repeatedly requesting account
   * health for every inaccessible file. This is a short-lived, per-token
   * cache: a changed token or expired window forces a fresh check.
   */
  private async deniedOrExpired(path: string): Promise<never> {
    if (!this.token) throw new SessionExpiredError(path);
    if (this.healthyToken === this.token && this.timing.now() < this.healthyUntil) {
      throw new ResourceDeniedError(path);
    }
    await this.pace();
    const account = await this.request(
      validateApiPath('/backend-api/accounts/check/v4-2023-04-27'), null, this.token,
    );
    const accounts = (account.body as { accounts?: unknown } | null)?.accounts;
    if (account.status === 200 && accounts && typeof accounts === 'object' &&
      !Array.isArray(accounts) && Object.keys(accounts).length > 0) {
      this.healthyToken = this.token;
      this.healthyUntil = this.timing.now() + 20_000;
      throw new ResourceDeniedError(path);
    }
    if (account.status === 401 || account.status === 403) throw new SessionExpiredError(path);
    throw new SessionCheckError(account.status);
  }

  /**
   * Admission is serialized, but the deadline must be read again after EVERY
   * sleep: another in-flight worker may have just received HTTP 429.
   */
  private async pace(): Promise<void> {
    const previous = this.pacing;
    let release!: () => void;
    this.pacing = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      while (true) {
        if (this.halted) throw new ExportCancelledError();
        const now = this.timing.now();
        const due = Math.max(this.nextAt, this.cooldownUntil);
        if (now >= due) {
          // Reserve spacing only when the request is actually admitted.
          this.nextAt = now + this.gap;
          break;
        }
        const seconds = Math.ceil((due - now) / 1000);
        const limited = this.cooldownUntil > now;
        this.progress?.waiting(limited
          ? `Rate-limit pause: next request in ${seconds}s`
          : `Request spacing: next request in ${seconds}s`);
        await this.timing.sleep(Math.min(750, due - now));
      }
    } finally { release(); }
  }

  private recoveredSuccess(): void {
    this.successesSince429++;
    // One successful request does not erase an ongoing multi-worker 429 storm.
    // Recover gradually after several successful requests.
    if (this.successesSince429 >= 5) {
      this.consecutive429s = Math.max(0, this.consecutive429s - 1);
      this.gap = Math.max(this.initialGap, Math.floor(this.gap * 0.8));
      this.successesSince429 = 0;
    }
  }

  private backoff(status: number, attempt: number, retryAfter: string | null): number {
    if (status !== 429) return Math.min(30_000, 1000 * (2 ** attempt));
    this.consecutive429s = Math.min(20, this.consecutive429s + 1);
    this.successesSince429 = 0;
    this.gap = Math.min(16_000, Math.max(this.gap * 2, 1_000));
    const base = Math.min(MAX_RATE_LIMIT_PAUSE, 30_000 * (2 ** Math.min(this.consecutive429s - 1, 5)));
    const jitter = Math.floor(base * 0.15 * Math.min(1, Math.max(0, this.timing.random())));
    // The provider's explicit Retry-After is authoritative when longer.
    return Math.max(base + jitter, retryAfterMs(retryAfter, this.timing.now()));
  }

  async get(path: string, workspaceId: string | null = null): Promise<unknown> {
    const url = validateApiPath(path);
    if (!this.token) this.token = await this.sessionToken();
    if (!this.token) throw new ApiError(401, path, 'Sign in to ChatGPT in the application, then resume.');
    for (let attempt = 0; attempt <= 6; attempt++) {
      await this.pace();
      const response = await this.request(url, workspaceId, this.token);
      if (response.status === 200) {
        this.recoveredSuccess();
        return response.body;
      }
      if (response.status === 401) {
        // A single private endpoint returning 401 does NOT prove the entire
        // login has expired. Previous versions retried an unchanged token
        // seven times and aborted the whole archive over one restricted chat.
        const previousToken: string | undefined = this.token;
        this.token = await this.sessionToken();
        if (!this.token) throw new SessionExpiredError(path);
        if (attempt === 0 && this.token !== previousToken) {
          this.progress?.info('ChatGPT refreshed the session token; retrying once.');
          continue;
        }
        await this.deniedOrExpired(path);
      }
      const retryable = [408, 429].includes(response.status) || response.status >= 500;
      if (!retryable) throw new ApiError(response.status, path, `ChatGPT returned HTTP ${response.status}`);
      if (attempt === 6) {
        if (response.status === 429) throw new RateLimitExhausted(path);
        throw new ApiError(response.status, path, `HTTP ${response.status} after 7 attempts`);
      }
      const delay = this.backoff(response.status, attempt, response.retryAfter);
      this.cooldownUntil = Math.max(this.cooldownUntil, this.timing.now() + delay);
      this.progress?.info(response.status === 429
        ? `ChatGPT HTTP 429: shared pause ${Math.ceil(delay / 1000)}s; rate-limit streak ${this.consecutive429s}; retry ${attempt + 1}/6; request spacing ${this.gap}ms.`
        : `ChatGPT HTTP ${response.status}; retry ${attempt + 1}/6 after ${Math.ceil(delay / 1000)}s.`);
    }
    throw new Error('Unreachable retry state');
  }

  /**
   * Binary route for ChatGPT-owned file endpoints. Electron keeps cookies, and
   * redirect:'manual' ensures bearer tokens are NEVER sent to CDN redirects.
   * Only paths under the known ChatGPT API origin may be requested.
   */
  async openFile(path: string, workspaceId: string | null = null): Promise<Response> {
    const url = validateApiPath(path);
    if (!this.token) this.token = await this.sessionToken();
    if (!this.token) throw new SessionExpiredError(path);
    let refreshes = 0;
    for (let attempt = 0; attempt <= 6; attempt++) {
      await this.pace();
      const headers: Record<string, string> = {
        accept: '*/*', authorization: `Bearer ${this.token}`,
      };
      if (workspaceId) headers['ChatGPT-Account-Id'] = workspaceId;
      let response: Response;
      try {
        response = await this.session.fetch(url, {
          method: 'GET', headers, credentials: 'include', cache: 'no-store',
          redirect: 'manual', signal: AbortSignal.timeout(timeout),
        });
      } catch (error) {
        if (this.halted) throw new ExportCancelledError();
        if (attempt === 6) throw new ApiError(503, 'asset-binary', 'Asset network retries exhausted');
        const delay = this.backoff(503, attempt, null);
        this.cooldownUntil = Math.max(this.cooldownUntil, this.timing.now() + delay);
        this.progress?.info(`Asset network request interrupted; retry ${attempt + 1}/6 after ${Math.ceil(delay / 1000)}s.`);
        continue;
      }
      if ([408, 429].includes(response.status) || response.status >= 500) {
        const status = response.status;
        const retryAfter = response.headers.get('Retry-After');
        await response.body?.cancel().catch(() => undefined);
        if (attempt === 6) {
          if (status === 429) throw new RateLimitExhausted('asset-binary');
          throw new ApiError(status, 'asset-binary', `Asset HTTP ${status} after 7 attempts`);
        }
        const delay = this.backoff(status, attempt, retryAfter);
        this.cooldownUntil = Math.max(this.cooldownUntil, this.timing.now() + delay);
        this.progress?.info(status === 429
          ? `ChatGPT binary HTTP 429: shared pause ${Math.ceil(delay / 1000)}s; retry ${attempt + 1}/6.`
          : `ChatGPT binary HTTP ${status}; retry ${attempt + 1}/6 after ${Math.ceil(delay / 1000)}s.`);
        continue;
      }
      if (response.status !== 401) {
        if (response.ok) this.recoveredSuccess();
        return response;
      }
      await response.body?.cancel().catch(() => undefined);
      // Resource-level HTTP 401 does not imply the entire session has expired.
      const oldToken: string = this.token;
      this.token = await this.sessionToken();
      if (!this.token) throw new SessionExpiredError(path);
      if (this.token !== oldToken && refreshes++ === 0) continue;
      await this.deniedOrExpired(path);
    }
    throw new Error('Unreachable asset retry state');
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
      if (this.halted) throw new ExportCancelledError();
      this.progress?.info(`ChatGPT request interrupted: ${error instanceof Error ? error.name : 'network error'}. Retrying if possible.`);
      return { status: 503, body: null, retryAfter: null };
    }
  }
}
