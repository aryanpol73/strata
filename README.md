# Strata

**Conversations should crystallize, not evaporate.**

Strata is a messaging and collaboration platform. It does everything you'd expect from a chat app, and then adds a way
for conversations to turn into something lasting:

- **Branch-and-Merge.** Take a topic from any message into a focused side discussion, then merge the outcome back as a
  single resolution card. The original conversation stays intact.
- **Live blocks.** Checklists, sign-up rosters and info cards that everyone edits together inside the conversation,
  built on Yjs CRDTs.
- **Stream-to-Canvas.** Every conversation has a persistent knowledge layer. Anything can be filed there, and stays
  linked in both directions to where it was said.
- **Guest Bridges.** Invite an outsider into one branch with a secure link, with no account, and nothing else exposed.
- **Intent-Contract Delivery.** Senders declare intent (Whisper, Digest, Standard, or Blocking Acknowledgement) and the
  server honours it against each recipient's own rules, timezone and quiet hours.

> Strata is **not end-to-end encrypted**. See [the security model](docs/05-security-model.md).

## Quick start

Requirements: Node 22 or later, pnpm, and either Docker or the bundled development runner.

```bash
pnpm install
```

```bash
pnpm run setup
```

Start MongoDB and Redis, using one of these:

```bash
docker compose up -d mongo redis
```

```bash
pnpm infra
```

`pnpm infra` needs no Docker. It runs a persistent MongoDB and looks for Redis in `.tools/redis`, then on your PATH.
On Windows with MSYS2, `scripts/build-redis-msys.sh` builds official Redis source into `.tools/redis`.

Then run the app:

```bash
pnpm dev
```

Open <http://localhost:5173>. To create demo accounts and a starter conversation:

```bash
node scripts/seed-dev.mjs
```

The generated credentials are written to `.data/dev-accounts.json`, which git ignores.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | API on port 4000 and web on port 5173, with reload |
| `pnpm infra` | Local MongoDB and Redis without Docker |
| `pnpm test` | All tests. Server tests use a real MongoDB and a real Redis |
| `pnpm typecheck` | Type-check every package |
| `pnpm build` | Production builds |

## Layout

```
apps/server      Express API, Socket.IO gateway, BullMQ jobs
apps/web         React client, PWA
packages/shared  zod schemas, socket contracts, block definitions
docs/            Architecture, security, roadmap and status
```

## Documentation

| Document | Contents |
| --- | --- |
| [Development checklist](docs/CHECKLIST.md) | **Start here.** What's done, what's partial, what's pending |
| [Reference audit](docs/00-reference-audit.md) | What was learned from the reference repository |
| [Product requirements](docs/01-product-requirements.md) | Requirements and the branch visibility matrix |
| [Architecture](docs/02-architecture.md) | System design and decision records |
| [Data model](docs/03-data-model.md) | Collections, indexes and invariants |
| [API and events](docs/04-api-and-events.md) | REST and Socket.IO contracts |
| [Security model](docs/05-security-model.md) | Threats, controls and privacy implications |
| [Roadmap and risks](docs/06-roadmap-and-risks.md) | Phases and technical risks |
| [Deployment](docs/07-deployment.md) | Production configuration |
