/**
 * Small HTTP layer for providers: per-host concurrency + pacing, retries with exponential
 * backoff on 429/5xx/network errors (honouring Retry-After), timeouts, and de-duplication of
 * identical in-flight GETs. Runtime-agnostic (uses global fetch, injectable for tests).
 */
import { MarketDataError } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostPolicy {
  /** Max concurrent requests to the host. */
  concurrency: number;
  /** Minimum milliseconds between request starts to the host. */
  minIntervalMs: number;
}

export interface HttpClientOptions {
  fetch?: FetchLike;
  userAgent?: string;
  timeoutMs?: number;
  /** Retries after the first attempt. */
  retries?: number;
  /** Base backoff in ms (doubles each retry, with jitter). */
  backoffMs?: number;
  /** Cap for a single wait, including Retry-After. */
  maxBackoffMs?: number;
  hostPolicies?: Record<string, Partial<HostPolicy>>;
  defaultPolicy?: HostPolicy;
  sleep?: (ms: number) => Promise<void>;
  /** Called after every attempt (for logs/metrics). */
  onRequest?: (info: { url: string; status: number | 'error'; ms: number; attempt: number }) => void;
}

export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Concurrency limiter with a minimum spacing between task starts. */
export class Limiter {
  private active = 0;
  private lastStart = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly policy: HostPolicy,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.policy.concurrency) {
      // Wait for a finishing task to hand its slot over (active count unchanged).
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      const now = Date.now();
      const startAt = Math.max(now, this.lastStart + this.policy.minIntervalMs);
      this.lastStart = startAt;
      if (startAt > now) await this.sleep(startAt - now);
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'HttpError';
  }
}

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly limiters = new Map<string, Limiter>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly opts: Required<Omit<HttpClientOptions, 'fetch' | 'onRequest' | 'hostPolicies'>> &
    Pick<HttpClientOptions, 'onRequest' | 'hostPolicies'>;

  constructor(options: HttpClientOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.opts = {
      userAgent: options.userAgent ?? BROWSER_USER_AGENT,
      timeoutMs: options.timeoutMs ?? 15_000,
      retries: options.retries ?? 3,
      backoffMs: options.backoffMs ?? 800,
      maxBackoffMs: options.maxBackoffMs ?? 10_000,
      defaultPolicy: options.defaultPolicy ?? { concurrency: 4, minIntervalMs: 50 },
      sleep: options.sleep ?? defaultSleep,
      hostPolicies: options.hostPolicies,
      onRequest: options.onRequest,
    };
  }

  private limiterFor(host: string): Limiter {
    let l = this.limiters.get(host);
    if (!l) {
      const p = { ...this.opts.defaultPolicy, ...(this.opts.hostPolicies?.[host] ?? {}) };
      l = new Limiter(p, this.opts.sleep);
      this.limiters.set(host, l);
    }
    return l;
  }

  /** GET returning parsed JSON. Identical concurrent calls share one request. */
  getJson<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T> {
    return this.dedupe(`json ${url}`, async () => JSON.parse(await this.request(url, headers)) as T);
  }

  getText(url: string, headers: Record<string, string> = {}): Promise<string> {
    return this.dedupe(`text ${url}`, () => this.request(url, headers));
  }

  private dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async request(url: string, headers: Record<string, string>): Promise<string> {
    const host = new URL(url).host;
    const limiter = this.limiterFor(host);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      const started = Date.now();
      let retryAfterMs: number | undefined;
      try {
        const res = await limiter.run(() => this.fetchWithTimeout(url, headers));
        this.opts.onRequest?.({ url, status: res.status, ms: Date.now() - started, attempt });
        if (res.ok) return await res.text();
        const body = await res.text().catch(() => '');
        const err = new HttpError(res.status, url, body);
        if (res.status === 429 || res.status >= 500) {
          lastError = err;
          retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
        } else {
          throw err;
        }
      } catch (e) {
        if (e instanceof HttpError && e.status !== 429 && e.status < 500) throw e;
        if (!(e instanceof HttpError)) {
          this.opts.onRequest?.({ url, status: 'error', ms: Date.now() - started, attempt });
        }
        lastError = e;
      }
      if (attempt < this.opts.retries) {
        const exp = this.opts.backoffMs * 2 ** attempt;
        const jitter = Math.random() * this.opts.backoffMs * 0.5;
        await this.opts.sleep(Math.min(this.opts.maxBackoffMs, retryAfterMs ?? exp + jitter));
      }
    }
    if (lastError instanceof HttpError && lastError.status === 429) {
      throw new MarketDataError('RATE_LIMITED', `Upstream rate limit (429) persisted after ${this.opts.retries} retries: ${url}`);
    }
    if (lastError instanceof Error && lastError.name === 'TimeoutError') {
      throw new MarketDataError('TIMEOUT', `Upstream timeout: ${url}`);
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(timeoutError()), this.opts.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json, text/csv, */*', ...headers },
        signal: controller.signal,
      });
    } catch (e) {
      if (controller.signal.aborted) throw timeoutError();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

function timeoutError(): Error {
  const e = new Error('Request timed out');
  e.name = 'TimeoutError';
  return e;
}

export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}
