# Development checklist

Last updated 2026-11-05. The rule here is that nothing is marked complete without evidence.

- **Automated** means covered by a passing test.
- **Browser** means exercised by hand in a real browser against the running stack.

## Test results

| Suite | Result | What it runs against |
| --- | --- | --- |
| `packages/shared` | 9 of 9 | Yjs documents |
| `apps/server` | 208 of 208 | Real MongoDB 8.2, real Redis 7.4, real Socket.IO clients |
| `apps/web` | 16 of 16 | Store and block session logic |
| **Total** | **233 of 233** | |

Type-checking passes in all packages, with `strict` and `noUncheckedIndexedAccess`. Production builds pass. The largest
web chunk is 273 KB (88 KB gzipped).

**There are no automated browser tests yet.** The browser pass below was manual, and won't catch regressions by itself.

## Completed

| Feature | Evidence |
| --- | --- |
| Registration, login, argon2id, timing-equalized failures | Automated, Browser |
| Rotating refresh tokens, reuse detection, concurrency safety | Automated, Browser |
| Device sessions and instant revocation, including sockets | Automated |
| Socket authentication | Automated |
| Direct and group rooms, roles, ownership handover | Automated |
| Real-time messaging, per-room ordering, idempotent sends | Automated, Browser |
| Replies, reactions, edit, delete (tombstones) | Automated |
| Pagination and `rev`-based resync | Automated |
| Delivery and read receipts, unread and quiet counts | Automated, Browser |
| Presence across multiple tabs, typing indicators | Automated |
| Search scoped to the reader's rooms | Automated |
| Media on the disk provider: signing, type sniffing, signed URLs | Automated |
| Branch create, nest, resolve, reopen, merge, archive | Automated, Browser |
| Branch visibility matrix, cascade on removal | Automated |
| Exactly-once merge, crash recovery | Automated |
| Live blocks: checklist, roster, info card | Automated, Browser |
| Server-side CRDT validation, permissions, hostile input | Automated |
| Offline reconciliation, compaction, change history | Automated |
| Recovery after a refused edit | Automated |
| Canvas sections, kinds, version conflicts, reorder | Automated, Browser |
| Bidirectional references, filtered for each reader | Automated, Browser |
| Guest bridges: PIN, lockout, expiry, revocation, scopes | Automated, Browser |
| Guest isolation: adversarial suite | Automated |
| Delivery postures and policy engine, including DST | Automated |
| Digests, quiet hours, recipient rules | Automated |
| Blocking acknowledgement, reminders, expiry | Automated, Browser |
| Retry, leases, failure states, BullMQ scheduling on real Redis | Automated |
| Rate limits on real Redis | Automated |
| Production start-up checks, security headers, secure cookies | Smoke test of the built server |

All seven priority interactions from the brief were exercised in a browser: creating a branch, switching between parent
and branch, merging, editing live blocks with a second client, moving messages to the Canvas, navigating both ways
between Canvas and source, and selecting a posture.

## Partially completed

| Feature | State | What's left |
| --- | --- | --- |
| **Cloudinary** | Implemented behind the provider interface | **Never run.** No credentials. Needs a live test |
| **Web Push** | Server, service worker and opt-in written | **Never delivered a real push.** Delivery logic is tested with a stand-in sender |
| **Docker image** | Dockerfile and compose written | **Never built.** Docker wasn't available |
| **PWA and offline shell** | Manifest, icons and service worker are served | Install and offline start not tried in a browser |
| **Offline outbox** | Written, and reconnect resync happened during testing | Not tested by actually sending while offline |
| **Multi-node** | Redis adapter used in tests | Only one node at a time. Two real nodes never run together |
| **Mobile** | List, conversation and guest views checked at 375px | Canvas on mobile not visually checked. Touch drag untested. No real device |
| **Dark theme** | Used for the sign-in and guest pages | Main app not fully reviewed in dark |
| **Accessibility** | Dialog focus traps, labels, keyboard Canvas reorder | No screen reader or contrast audit |

## Pending

| Item | Notes |
| --- | --- |
| Gemini ecosystem research | **Not received.** Requirements come from the brief alone |
| UI references | **Not received.** Tokens are all in `apps/web/src/styles/index.css`, ready for them |
| Automated browser tests | Recommended next. Playwright, covering the seven priority flows |
| Email verification and password reset | Needs an email provider |
| Two-factor authentication | |
| Abuse reporting and moderation | |
| Upload malware scanning | |
| Account deletion and data export | |
| External penetration test | Should happen before public launch |

**Future features** (Decision Ledger, Time-Scrubber, Voice Chapters, Symmetrical Attention, Entity Drawer, Ghost Bubbles,
Multi-Persona Identity, Shadow Scribe, Spatial Audio, Slow-Pact Rooms, Micro-Applets, Cascade Redaction) are deliberately
not built. `docs/02-architecture.md` lists the extension point for each.

## Known issues

| Issue | Impact |
| --- | --- |
| Whoever merges a branch sees their own resolution card as unread until they open the room | Cosmetic |
| Yjs updates over the socket have a size limit but no rate limit | An authorized member could flood a block |
| Unread counts run one query per room with unread messages | Fine now, needs a counter at scale |
| Search uses MongoDB `$text`, which is weak on languages without word spacing | Replace with Atlas Search before it matters |
| Canvas shows a stale excerpt if a source message is later edited | By design for now, as the Canvas keeps what was extracted |
| A read-only merged transcript isn't listed in the sidebar | Reached from the resolution card only |
| The bundled `pnpm infra` downloads a large MongoDB binary the first time | About 780 MB, then cached |

## Bugs found by testing, now fixed

Kept here because each one shaped a test that now guards it.

| Bug | Found by | Severity |
| --- | --- | --- |
| Guest could learn a nested branch's id from a sanitized message's sender field | Adversarial guest suite | **Security** |
| Two simultaneous refreshes cleared the winner's cookie, signing the user out | Reloading in the browser | **High** |
| After a refused block edit, every later edit from that client failed | Client test | **High** |
| Direct room creation race returned a room without its members | Concurrency test | Medium |
| Parent admins couldn't manage listed branches they weren't in | Branch test | Medium |
| Blocks failed to load, because lean queries return BSON Binary | Block tests | Medium |
| Canvas panel went blank on desktop after adding a block | Browser | Medium |
| Dialogs stole focus whenever the parent re-rendered | Code review during browser testing | Medium |
| A link was nested inside a button in the room header | Code review during browser testing | Low |
| Global CSS overrode Tailwind's `outline-none`, doubling focus rings | Browser | Low |
