import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnv, resetEnv } from '../src/config/env.js';

const production = {
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/env_test',
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
