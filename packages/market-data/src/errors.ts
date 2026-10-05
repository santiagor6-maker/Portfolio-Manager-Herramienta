export type MarketDataErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'UPSTREAM_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT';

const STATUS: Record<MarketDataErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  UNSUPPORTED: 422,
  UPSTREAM_ERROR: 502,
  RATE_LIMITED: 503,
  TIMEOUT: 504,
};

export class MarketDataError extends Error {
  readonly code: MarketDataErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: MarketDataErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
