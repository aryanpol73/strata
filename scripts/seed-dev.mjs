// Creates demo accounts and a starter conversation through the real API, for local development only.
// Credentials go to .data/dev-accounts.json, which git ignores.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const API = process.env.API_URL ?? 'http://localhost:4000/api';
const FILE = '.data/dev-accounts.json';

if (!/localhost|127\.0\.0\.1/.test(API)) {
  console.error('Refusing to seed anything but a local server.');
  process.exit(1);
}

async function call(path, { token, ...init } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

if (existsSync(FILE)) {
  console.log(`${FILE} already exists. Delete it and the database to seed again.`);
  process.exit(0);
}

const password = randomBytes(12).toString('base64url');
const people = [
  ['Ada Moreno', 'ada_moreno'],
  ['Bo Lindqvist', 'bo_lindqvist'],
  ['Cy Okafor', 'cy_okafor'],
];

const accounts = [];
for (const [displayName, handle] of people) {
  const email = `${handle}@strata.test`;
  const res = await call('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName, handle }) });
  accounts.push({ displayName, handle, email, id: res.user.id, token: res.accessToken });
}
const [ada, bo, cy] = accounts;

const { room } = await call('/rooms/group', {
  method: 'POST',
  token: ada.token,
  body: JSON.stringify({ name: 'Riverside Launch', memberIds: [bo.id, cy.id] }),
});

const say = (who, text) =>
  call(`/rooms/${room.id}/messages`, {
    method: 'POST',
    token: who.token,
    body: JSON.stringify({ clientMessageId: crypto.randomUUID(), content: { type: 'text', text } }),
  });

await say(ada, 'Morning all. Venue confirmed for the 14th, 200 seats.');
await say(bo, 'Great. The caterer needs a final headcount by Friday.');
await say(cy, 'Should we move the launch earlier so it does not clash with the conference?');
await say(ada, 'Good question. https://example.test/venue-plan has the floor plan too.');

mkdirSync('.data', { recursive: true });
writeFileSync(FILE, JSON.stringify({ password, accounts: accounts.map(({ token: _token, ...a }) => a) }, null, 2));
console.log(`Seeded ${accounts.length} accounts and one group. Credentials are in ${FILE}.`);
