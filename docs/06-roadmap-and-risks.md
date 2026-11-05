# Roadmap and technical risks

## Roadmap

| Phase | Scope | Exit test |
| --- | --- | --- |
| 0 | Audit, requirements, architecture | This document set |
| 1 | Monorepo, config, Mongo, Redis, auth, sessions, sockets | Rotation, reuse detection, and socket auth tests pass |
| 2 | Rooms, messages, receipts, media, search | Idempotency, ordering, and authorization tests pass |
| 3 | Branch-and-Merge | Visibility matrix test passes |
| 4 | Guest Bridges | Adversarial isolation suite passes |
| 5 | Live blocks | Convergence, reconnect, and compaction tests pass |
| 6 | Stream-to-Canvas | Reference filtering and reorder tests pass |
| 7 | Intent-Contract Delivery | Timezone, digest, deadline, and failure tests pass |
| 8 | Polish and end-to-end verification | Real browser run, responsive review |
| 9 | Deployment configuration | Docker build and runbook |

Live progress is tracked in [`CHECKLIST.md`](./CHECKLIST.md).

## Technical risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| 1 | Data leaking between branch and parent, or to guests | Critical | Rooms as the isolation unit. One access module. Default-deny guest fan-out. Adversarial tests |
| 2 | CRDT updates bypass permissions | High | Validate on a copy of the document before persisting (ADR-6) |
| 3 | Block update log grows without bound | Medium | Compaction with compare-and-set. Activity kept separately |
| 4 | Compaction races with a reader | Medium | Readers re-check `snapshotSeq` and retry |
| 5 | Lost notifications, or duplicates, on crash | High | State in Mongo, leased claims, unique key per recipient and message |
| 6 | DST and timezone errors in digests | Medium | IANA zones through Luxon, with tests across DST transitions |
| 7 | BLOCKING ACK used for harassment | Medium | Role policy, rate limit, recipient opt-out from quiet-hours bypass |
| 8 | Refresh races across browser tabs | Medium | Web Locks on the client, plus a 10-second grace window on the server |
| 9 | Missed socket events | Medium | `rev` feed resync on reconnect |
| 10 | `$text` search won't scale, and has weak CJK support | Low now | Isolated behind one service, ready for Atlas Search |
| 11 | Mongo write hot spot on `Room.rev` in very busy rooms | Low now | Acceptable to thousands of messages per minute per room. Shard counters only if measured |
| 12 | Yjs tombstones accumulate in long-lived documents | Low | Blocks are small by design, with item limits per type |
| 13 | Guest link forwarded | Inherent | PIN, short expiry, session visibility, instant revocation. Disclosed in the UI |
| 14 | Unverified integrations (Cloudinary, Web Push) | Medium | Behind interfaces, with credentials documented as outstanding |
