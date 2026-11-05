import { defineConfig, devices } from '@playwright/test';

const PORT = 4200;

/**
 * Runs the production web build, served by the built server, so that the real CSP, service worker and bundle splitting
 * are all under test. Needs MongoDB and Redis, from `pnpm infra` or Docker, and `pnpm build` first.
 */
export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '../../.tools/e2e-results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', testIgnore: /mobile/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', testMatch: /mobile/, use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node dist/main.js',
    cwd: '../server',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'development',
      PORT: String(PORT),
      MONGODB_URI: process.env.E2E_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/strata_e2e',
      REDIS_URL: process.env.E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/5',
      JWT_SECRET: 'e2e-only-secret-that-is-long-enough-for-signing',
      MEDIA_SIGNING_SECRET: 'e2e-only-media-secret-long-enough-for-signing',
      APP_URL: `http://localhost:${PORT}`,
      CORS_ORIGINS: `http://localhost:${PORT}`,
      WEB_DIST: '../web/dist',
      MEDIA_DIR: '../../.tools/e2e-uploads',
      RATE_LIMITS_ENABLED: 'false',
      DELIVERY_SWEEP_SECONDS: '1',
      LOG_LEVEL: 'warn',
    },
  },
});
