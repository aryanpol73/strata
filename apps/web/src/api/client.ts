import type { ApiErrorBody, ErrorCode } from '@strata/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  raw?: BodyInit;
}

/**
 * One HTTP client, parameterized so that members and guests share it. The access token lives only in this closure's
 * memory, so an XSS bug can't read it from storage. A page reload gets a new one through the HttpOnly cookie.
 */
export function createClient(config: { refreshPath: string; lockName: string; onSignedOut: () => void }) {
  let token: string | null = null;
  let refreshing: Promise<boolean> | null = null;

  async function refreshOnce(): Promise<boolean> {
    const res = await fetch(`/api${config.refreshPath}`, { method: 'POST', headers: { 'x-strata-client': 'web' }, credentials: 'same-origin' });
    if (!res.ok) return false;
    const body = (await res.json()) as { accessToken: string };
    token = body.accessToken;
    return true;
  }

  /** Tabs share a refresh cookie that rotates, so only one tab refreshes at a time. */
  function refresh(): Promise<boolean> {
    refreshing ??= (navigator.locks ? navigator.locks.request(config.lockName, refreshOnce) : refreshOnce()).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function send(path: string, options: RequestOptions): Promise<Response> {
    const url = new URL(`/api${path}`, location.origin);
    for (const [k, v] of Object.entries(options.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { ...options.headers };
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        credentials: 'same-origin',
        body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      });
    } catch {
      throw new ApiError(0, 'NETWORK', 'You appear to be offline');
    }
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let res = await send(path, options);
    if (res.status === 401 && token !== null && (await refresh().catch(() => false))) res = await send(path, options);
    if (res.status === 401 && token !== null) {
      token = null;
      config.onSignedOut();
    }
    if (res.status === 204) return undefined as T;
    const body = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
    if (!res.ok) {
      const error = body?.error;
      throw new ApiError(res.status, error?.code ?? 'INTERNAL', error?.message ?? 'Something went wrong', error?.details);
    }
    return body as T;
  }

  return {
    request,
    refresh,
    getToken: () => token,
    setToken: (next: string | null) => {
      token = next;
    },
  };
}

let onSignedOut: () => void = () => {};
export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn;
};

export const client = createClient({ refreshPath: '/auth/refresh', lockName: 'strata-refresh', onSignedOut: () => onSignedOut() });
export const api = client.request;

/** Cookie-authenticated calls need this header, which cross-site forms can't send. */
export const CLIENT_HEADER = { 'x-strata-client': 'web' };
