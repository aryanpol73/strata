import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnv, resetEnv } from '../src/config/env.js';

const production = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb+srv://user:pass@cluster.example.net/strata?retryWrites=true',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_SECRET: 'a'.repeat(40),
  MEDIA_SIGNING_SECRET: 'b'.repeat(40),
  APP_URL: undefined,
  CORS_ORIGINS: undefined,
  MEDIA_PROVIDER: 'disk',
};

describe('the address a host announces at runtime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnv();
  });

  const load = (vars: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries({ ...production, ...vars })) vi.stubEnv(key, value);
    resetEnv();
    return getEnv();
  };

  it('fills in the app address and allowed origin', () => {
    const env = load({ RENDER_EXTERNAL_URL: 'https://strata.onrender.com' });
    expect(env.APP_URL).toBe('https://strata.onrender.com');
    expect(env.CORS_ORIGINS).toBe('https://strata.onrender.com');
  });

  it('gives way to an address set on purpose', () => {
    const env = load({ RENDER_EXTERNAL_URL: 'https://strata.onrender.com', APP_URL: 'https://chat.example.org', CORS_ORIGINS: 'https://chat.example.org' });
    expect(env.APP_URL).toBe('https://chat.example.org');
  });
});

describe('the production database address', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnv();
  });

  const load = (uri: string, plaintext?: string) => {
    for (const [key, value] of Object.entries({ ...production, APP_URL: 'https://a.test', MONGODB_URI: uri, MONGODB_ALLOW_PLAINTEXT: plaintext })) vi.stubEnv(key, value);
    resetEnv();
    return getEnv();
  };

  it('has to be encrypted', () => {
    expect(() => load('mongodb://db.example.net/strata')).toThrow(/TLS/);
    expect(load('mongodb://db.example.net/strata?tls=true').MONGODB_URI).toContain('tls');
  });

  it('can stay plain on a private network, when that is said outright', () => {
    expect(load('mongodb://mongo:27017/strata', 'true').MONGODB_ALLOW_PLAINTEXT).toBe(true);
  });

  it('has to name a database, or everything lands in `test`', () => {
    expect(() => load('mongodb+srv://u:p@cluster.example.net/?retryWrites=true')).toThrow(/name a database/);
  });
});
