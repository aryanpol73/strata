# Development checklist

Last updated 2026-11-05. The rule here is that nothing is marked complete without evidence.

- **Automated** means covered by a passing server, client or shared test.
- **Browser** means covered by an automated Playwright test, run against the production build with its real CSP.

## Test results

| Suite | Result | What it runs against |
| --- | --- | --- |
| `packages/shared` | 9 of 9 | Yjs documents |
| `apps/server` | 221 of 221 | Real MongoDB 8.2, real Redis 7.4, real Socket.IO clients, and a second real server process |
| `apps/web` | 20 of 20 | Store and block session logic |
| `apps/e2e` | 53 of 53 | Real Chromium, with separate contexts for each person. Fails on any page error or CSP violation |
| **Total** | **303 of 303** | |

Type-checking passes in all packages, with `strict` and `noUncheckedIndexedAccess`. Production builds pass. The largest
web chunk is 273 KB (88 KB gzipped). Accessibility audits (axe, WCAG 2.1 AA) pass on the main screens in both themes.

The browser suite also passed twice over in one run, and the offline tests six times over, because some of the bugs
below only appeared intermittently.

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
| Rate limits on real Redis, and a budget on socket writes | Automated |
| Multiple API nodes: fan-out, revocation, presence, CRDT convergence | Automated, against two real processes |
| Offline: outbox, resync, cold start from the service worker | Browser |
| Local data cleared on sign-out | Browser |
| Mobile: separate screens, action sheet, Canvas view, no side scroll | Browser, emulated Pixel 7 |
| Accessibility: WCAG AA contrast and structure, both themes | Browser, axe |
| Production start-up checks, security headers, secure cookies | Smoke test of the built server |

All seven priority interactions from the brief are covered by automated browser tests: creating a branch, switching between parent
and branch, merging, editing live blocks with a second client, moving messages to the Canvas, navigating both ways
between Canvas and source, and selecting a posture.

## Partially completed

| Feature | State | What's left |
| --- | --- | --- |
| **Cloudinary** | Implemented behind the provider interface | **Never run.** No credentials. Needs a live test |
| **Web Push** | Server, service worker and opt-in written | **Never delivered a real push.** Delivery logic is tested with a stand-in sender |
| **Docker image** | Dockerfile and compose written | **Never built.** Docker wasn't available |
| **PWA install** | Manifest, icons and offline start are tested | The install prompt itself hasn't been tried |
| **Mobile** | Emulated phone covered | No real device. Touch dragging on the Canvas untested. Keyboard and mouse dragging are tested |
| **Accessibility** | Automated audit, keyboard Canvas reorder, dialog focus traps | Automated tools catch only part of the problem. No screen reader testing yet |

## Pending

| Item | Notes |
| --- | --- |
| Gemini ecosystem research | **Not received.** Requirements come from the brief alone |
| UI references | **Not received.** Tokens are all in `apps/web/src/styles/index.css`, ready for them |
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
| A refresh response lost in transit leaves the browser with a superseded token, which reuse detection ends after 10 seconds | Safe failure, but that person has to sign in again. Could matter on poor mobile networks |
| Block rules are checked against each node's latest view, so two nodes can both accept near-simultaneous edits | Only affects rules that compare edits, such as limits on item count. Permissions are unaffected |
| Whoever merges a branch sees their own resolution card as unread until they open the room | Cosmetic |
| Unread counts run one query per room with unread messages | Fine now, needs a counter at scale |
| Search uses MongoDB `$text`, which is weak on languages without word spacing | Replace with Atlas Search before it matters |
| Canvas shows a stale excerpt if a source message is later edited | By design for now, as the Canvas keeps what was extracted |
| A read-only merged transcript isn't listed in the sidebar | Reached from the resolution card only |
| The bundled `pnpm infra` downloads a large MongoDB binary the first time | About 780 MB, then cached |
| One browser test failed once with `Unexpected end of JSON input` in a test helper | **Unexplained.** It didn't recur in the 150+ test runs since. Watch for it |

## Bugs found by testing, now fixed

Kept here because each one shaped a test that now guards it.

| Bug | Found by | Severity |
| --- | --- | --- |
| Guest could learn a nested branch's id from a sanitized message's sender field | Adversarial guest suite | **Security** |
| A node's block cache could permanently miss an edit made through another node | Two-node test | **High** |
| A message sent while reconnecting was deleted from the outbox | Browser, offline cold start | **High** |
| Messages arriving while a page was loading vanished from the screen | Browser, repeated runs | **High** |
| A message could be lost if the tab closed just after it showed as sending | Browser, repeated runs | Medium |
| An app started offline didn't reliably connect when the network returned | Browser | Medium |
| The outbox could stall if HTTP failed while the socket stayed up | Writing the offline tests | Medium |
| Going offline took up to a minute to notice | Browser | Medium |
| Change history dropped entries made within a minute of each other | Investigating a browser failure | Medium |
| Muted text and tinted labels failed WCAG AA contrast in both themes | axe audit | Medium |
| A clock stepping backwards drained the socket budget | Client test | Low |
| Two simultaneous refreshes cleared the winner's cookie, signing the user out | Reloading in the browser | **High** |
| After a refused block edit, every later edit from that client failed | Client test | **High** |
| Direct room creation race returned a room without its members | Concurrency test | Medium |
| Parent admins couldn't manage listed branches they weren't in | Branch test | Medium |
| Blocks failed to load, because lean queries return BSON Binary | Block tests | Medium |
| Canvas panel went blank on desktop after adding a block | Browser | Medium |
| Dialogs stole focus whenever the parent re-rendered | Code review during browser testing | Medium |
| A link was nested inside a button in the room header | Code review during browser testing | Low |
| Global CSS overrode Tailwind's `outline-none`, doubling focus rings | Browser | Low |
