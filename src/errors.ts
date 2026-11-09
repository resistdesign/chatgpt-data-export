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
