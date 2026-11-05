import { z } from 'zod';

const boolish = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  /** `all` runs API and workers together. Split them in production by running one of each. */
  ROLE: z.enum(['all', 'api', 'worker']).default('all'),
  MONGODB_URI: z.string().min(1),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  MEDIA_SIGNING_SECRET: z.string().min(32, 'MEDIA_SIGNING_SECRET must be at least 32 characters'),
  APP_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Number of proxy hops in front of the app. Zero ignores X-Forwarded-For, so it can't be spoofed. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  RATE_LIMITS_ENABLED: boolish.default(true),
  MEDIA_PROVIDER: z.enum(['disk', 'cloudinary']).default('disk'),
  MEDIA_DIR: z.string().default('./uploads'),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  DELIVERY_SWEEP_SECONDS: z.coerce.number().int().min(1).default(15),
  BLOCK_COMPACT_THRESHOLD: z.coerce.number().int().min(2).default(200),
  LOG_LEVEL: z.string().default('info'),
  /** Set to serve the built web client from this process. */
  WEB_DIST: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

function productionProblems(env: Env): string[] {
  const problems: string[] = [];
  if (!env.REDIS_URL) problems.push('REDIS_URL is required in production');
  if (!env.APP_URL.startsWith('https://')) problems.push('APP_URL must use https in production');
  if (env.CORS_ORIGINS.includes('*')) problems.push('CORS_ORIGINS may not contain a wildcard');
  if (env.JWT_SECRET === env.MEDIA_SIGNING_SECRET) problems.push('JWT_SECRET and MEDIA_SIGNING_SECRET must differ');
  if (/change.?me|example|secret123/i.test(env.JWT_SECRET)) problems.push('JWT_SECRET is a placeholder');
  if (env.MEDIA_PROVIDER === 'cloudinary' && !(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET)) {
    problems.push('Cloudinary credentials are missing');
  }
  return problems;
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${lines}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    const problems = productionProblems(parsed.data);
    if (problems.length) throw new Error(`Refusing to start:\n  ${problems.join('\n  ')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test support: forget the cached environment after changing process.env. */
export function resetEnv(): void {
  cached = undefined;
}
