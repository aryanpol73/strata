// Creates .env from .env.example, filling in random secrets. Never overwrites an existing .env.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('.env already exists, leaving it alone.');
  process.exit(0);
}
const secret = () => randomBytes(48).toString('base64url');
const env = readFileSync('.env.example', 'utf8')
  .replace(/^JWT_SECRET=$/m, `JWT_SECRET=${secret()}`)
  .replace(/^MEDIA_SIGNING_SECRET=$/m, `MEDIA_SIGNING_SECRET=${secret()}`);
writeFileSync('.env', env);
console.log('Created .env with fresh secrets.');
