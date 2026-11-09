export class ApiError extends Error {
  constructor(readonly status: number, readonly endpoint: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class RateLimitExhausted extends Error {
  constructor(readonly endpoint: string) {
    super('ChatGPT rate limits did not clear after retries; stop and resume later.');
    this.name = 'RateLimitExhausted';
  }
}

/** A verified loss of account authentication, not an inaccessible conversation. */
export class SessionExpiredError extends ApiError {
  constructor(endpoint: string) {
    super(401, endpoint, 'The ChatGPT login is no longer authenticated. Reopen sign-in, then resume.');
    this.name = 'SessionExpiredError';
  }
}

/** The account session is healthy, but one endpoint is not authorized. */
export class ResourceDeniedError extends ApiError {
  constructor(endpoint: string) {
    super(401, endpoint, 'ChatGPT denied this resource (HTTP 401), but the account session is still authenticated.');
    this.name = 'ResourceDeniedError';
  }
}

/** A transient or unexpected response makes the login status inconclusive. */
export class SessionCheckError extends Error {
  constructor(readonly status: number) {
    super(`Could not establish whether the ChatGPT login is valid after HTTP 401 (account check HTTP ${status}). Saved data is intact; retry later.`);
    this.name = 'SessionCheckError';
  }
}

/** Expected cancellation of an in-flight or queued request, not a failed chat. */
export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled. Saved checkpoints are retained.');
    this.name = 'ExportCancelledError';
  }
}
