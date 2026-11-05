# System architecture

```
                     ┌──────────────────────────────────────────┐
  Browser / PWA      │  apps/web  React 19, Vite, Tailwind      │
                     │  Dexie cache + outbox, Service Worker    │
                     └───────┬───────────────────┬──────────────┘
                 commands    │ HTTPS             │ WebSocket   events, presence, Yjs
                             ▼                   ▼
                     ┌──────────────────────────────────────────┐
  apps/server        │  Express API   │  Socket.IO gateway      │  N stateless nodes
                     │  ───────────── domain services ───────── │
                     │  rooms messages branches guests blocks   │
                     │  canvas delivery media auth              │
                     └───┬─────────────┬───────────────┬────────┘
                         ▼             ▼               ▼
                     MongoDB        Redis          Cloudinary / disk
                     source of      adapter,       media bytes
                     truth          BullMQ,
                                    rate limits,
                                    presence
  packages/shared    zod schemas: the single contract used by server and client
```

## Layout

```
apps/server/src
  config/      validated environment
  lib/         errors, logger, tokens, redis, http helpers
  models/      Mongoose schemas and indexes
  modules/     one folder per domain: routes + service
  realtime/    gateway, event fan-out, presence, block sync
  jobs/        BullMQ wiring and the delivery sweep
apps/web/src
  api/  state/  realtime/  features/  components/  styles/
packages/shared/src
  schemas, socket event maps, block definitions
```

## Architecture decision records

### ADR-1: A branch is a room

`Room.kind` is `direct`, `group` or `branch`. A branch adds `parentRoomId`, `parentMessageId` and a `branch` subdocument.

Messages, receipts, blocks, Canvas, search, and notifications therefore work inside branches with no extra code, and
there is exactly one place to enforce access. The alternative, a `threadId` on messages, would mean every query must
remember a filter. A forgotten filter becomes a data leak. Here, leaks need a membership bug instead, and membership is
checked in one function.

### ADR-2: Commands over HTTP, events over sockets

All state changes are REST calls. Sockets carry server-to-client events, plus three ephemeral or binary client streams:
typing, delivery watermarks, and Yjs updates.

One path means one place for validation, authorization, rate limits and idempotency. It also means failures have status
codes and retry cleanly. The cost is one HTTP round trip per send, which is negligible on keep-alive connections.

### ADR-3: One ordering counter per room

`Room.rev` increments atomically on every persisted change. A new message takes `seq = rev`. An edit, delete, or reaction
sets `message.rev` to a fresh value.

- `seq` gives a stable display order.
- `rev` gives a complete change feed. Reconnecting is one query: `GET /rooms/:id/sync?sinceRev=N`.

There is no multi-document transaction. If a process dies between `$inc` and insert, the only result is a harmless gap.
So Strata needs no replica set for correctness.

### ADR-4: Persist, then acknowledge, then fan out

The sequence is: validate, authorize, write to Mongo, respond, publish to sockets. Sockets are a latency optimization,
never the source of truth, and a dropped event is repaired by the `rev` feed. Sends carry a `clientMessageId`, and a
unique index on `(roomId, senderId, clientMessageId)` makes a retry return the original message.

### ADR-5: Receipts are watermarks

`RoomMember` stores `lastDeliveredSeq` and `lastReadSeq`. Marking a room read is one write however many messages were
read. Per-message "seen by" is derived by comparing `seq` with member watermarks.

### ADR-6: Yjs relay with server-side validation

The server is not a blind relay. It holds a bounded LRU of `Y.Doc`s, which it refreshes from Mongo before each write,
so nodes stay correct without sticky sessions.

For each update: authorize, decode, apply to a *copy* of the doc, run the block type's `validate(before, after, actor)`,
then append to `BlockUpdate`, acknowledge, and broadcast. Validation is what makes rules like "you may only sign
*yourself* up" real rather than cosmetic. A pure relay can't enforce them, because a CRDT update is otherwise opaque.

Sequence numbers are allocated before their rows are written, so a lower number from another node can land after a
higher one. Each cached doc therefore tracks a contiguous watermark that never passes a gap, and reapplies anything above
it, which Yjs makes harmless.

A compaction pass merges updates into `Block.snapshot` when the log passes a threshold. It uses compare-and-set on
`snapshotSeq`, so readers either see the old snapshot with the full log or the new one with the remainder.

### ADR-7: Mongo holds delivery state, and a timer in the app provides the clock

Each `Notification` row is a small state machine with `dueAt`. A timer in each worker runs a sweep that claims due rows with an
atomic lease. The schedule used to live in BullMQ, but a Redis wipe removed it and stopped all delivery until a restart,
so Redis no longer has any part in the clock. Compared with one delayed job per notification, a Redis flush loses nothing, a deadline is a field update
rather than a job cancellation, and the state is directly queryable for the sender's delivery status view.

### ADR-8: Guests are a separate principal on a separate router

Guests get `/api/guest/*` only. Guest JWTs have a different `aud`, so user middleware rejects them outright. Guest
sockets join a separate channel, `guest:<roomId>`, and events reach it only through an allowlist with explicit sanitizers.
Adding a new event therefore exposes nothing to guests by default.

### ADR-9: Canvas uses optimistic concurrency, not CRDT

Canvas blocks are short, edited by few people at a time, and need server-side relationships and ordering. They use a
version check with fractional ordering keys. Yjs stays where concurrent character-level editing actually happens, and
live blocks can still be embedded in a Canvas.

### ADR-10: Message deletion is a tombstone

Deleting clears the payload but keeps the row, so `seq` order, replies, and citations remain valid. Citations then show
"original message deleted". This is also the base that Cascade Redaction will build on.

## Infrastructure notes

| Component | Use | Without it |
| --- | --- | --- |
| MongoDB | Source of truth | Required |
| Redis | Socket.IO adapter, BullMQ, rate limits, presence | Required in production. In development, the server warns and falls back to a single-node mode with an interval-driven sweep |
| Cloudinary | Media in production | The disk provider is a real implementation for development |
| Web Push (VAPID) | Background notifications | In-app notifications still work |

Single-node mode shares all business logic. Only the trigger for the sweep and the rate-limit store differ.

## Client state

- **Zustand** holds live state. The socket layer writes to it directly.
- **Dexie** holds rooms and recent messages for instant start and offline reading, plus an **outbox** for messages sent
  while offline. Outbox entries keep their `clientMessageId`, so retries are safe.
- **Service Worker** caches the app shell and receives Web Push.
- The access token lives in memory only. A page reload restores it through the refresh cookie.

## Extension points for future features

| Feature | Hook |
| --- | --- |
| Decision Ledger | `decision` Canvas kind and `resolution` payloads become a queryable collection |
| Time-Scrubber | Room `rev` feed already supports replay |
| Annotated Voice Chapters | New payload type on the message union |
| Symmetrical Attention | `NotificationPreference` plus a status broadcast through presence |
| Entity Drawer | New Canvas kinds, citations as graph edges |
| Ghost Bubbles | Another ephemeral socket stream, alongside typing |
| Multi-Persona Identity | `Principal` abstraction. Add a persona id to the sender |
| Shadow Scribe | A service principal consuming the `rev` feed. Requires explicit consent design |
| Spatial Audio | Separate media service, keyed by room |
| Slow-Pact Rooms | Room settings consumed by the delivery policy |
| Micro-Applets | New entry in the block registry |
| Cascade Redaction | Tombstones plus the citation graph identify what to redact |
