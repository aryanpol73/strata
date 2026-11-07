# Development checklist

Last updated 2026-11-07. The rule here is that nothing is marked complete without evidence.

- **Automated** means covered by a passing server, client or shared test.
- **Browser** means covered by an automated Playwright test, run against the production build with its real CSP.

## Test results

| Suite | Result | What it runs against |
| --- | --- | --- |
| `packages/shared` | 9 of 9 | Yjs documents |
| `apps/server` | 257 of 257 | Real MongoDB 8.2, real Redis 7.4, real Socket.IO clients, and a second real server process |
| `apps/web` | 20 of 20 | Store and block session logic |
| `apps/e2e` | 89 of 89 | Real Chromium, with separate contexts for each person. Fails on any page error or CSP violation |
| **Total** | **375 of 375** | |

Type-checking passes in all packages, with `strict` and `noUncheckedIndexedAccess`. Production builds pass. The largest
web chunk is 273 KB (88 KB gzipped). Accessibility audits (axe, WCAG 2.1 AA) pass on the main screens in all four looks: Violet and Emerald, each dark and light, including every Settings section.

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

### Visual redesign

- [x] Deep and Day themes, chosen in Settings and kept across reloads (Browser, audited in both)
- [x] Desktop rail, inbox and Canvas panels; floating glass tab bar on phones, hidden in conversations (Browser)
- [x] Message bubbles, floating glass composer, sliding Stream/Canvas switch (Browser)
- [x] Branches and Attention screens, with Needs You and acknowledgement from the list (Automated, Browser)
- [x] Buttons respond to the pointer, show progress while busy, and stay still under reduced motion (Browser)

### Themes, logo, photos and Settings

- [x] Violet and Emerald colour themes, each dark, light or matching the device (Browser, audited)
- [x] App icon choice per person, covering the tab, in-app logo and install manifest (Browser)
- [x] Appearance choices follow a person to new devices (Browser)
- [x] Profile photos with crop, public or private, and the old address retired on going private (Browser)
- [x] Settings in seven sections, including password change, appearing offline, storage and install (Browser for password and appearing offline)

An installed app keeps the icon it was installed with until it's reinstalled, and push notifications always use the
violet icon. Photos change for other people the next time they load the conversation, not live. Guests never see photos.

### Notifications and digests

Investigated after notifications weren't arriving. The causes, and what changed:

- [x] **Push was never switched on.** It needs a key pair nobody had set. Keys are now generated once and kept in MongoDB (Automated)
- [x] **Push only went to people with no open connection,** which excluded a phone with the app in the background. It now goes whenever no window is in front of the person (Automated)
- [x] **Messages showed no alert while the app was open elsewhere.** They now raise an in-app alert, an unread count in the tab title and on an installed app's icon
- [x] **Nobody was asked to turn push on.** A prompt now appears in the inbox, and Settings shows the real state of this device, with a way to turn it off
- [x] **Digest was invisible.** It now has a held-items list on the Attention screen with a "Send now" button, a per-conversation "Digest only" setting, a plain explanation in Settings, and a summary that names the conversations (Automated)
- [ ] **Real push delivery** to a real browser subscription is still unverified, and push on an iPhone needs the app added to the home screen
- [ ] **The free Render plan sleeps,** so timed work such as digests runs late while it does. See the deployment guide

### End-to-end encryption

- [x] Text messages in direct conversations, groups and branches are encrypted in the browser, and the server stores only ciphertext (Automated, Browser)
- [x] The server refuses plaintext in an encrypted conversation, and refuses ciphertext in a plain one (Automated)
- [x] Keys: a passphrase-protected backup, per-conversation keys sealed to each member, sharing with late joiners, and replacement when someone leaves (Automated, Browser)
- [x] A new device needs the passphrase, a wrong one is refused, and a changed passphrase keeps access (Browser)
- [x] Security codes, and a warning that blocks sharing when someone's key changes until it's accepted (Browser)
- [x] Replies, edits and inbox previews work on encrypted messages (Browser)
- [x] Guests can't be invited to an encrypted branch, and a branch with guests says it isn't encrypted (Automated, Browser)
- [ ] **No independent review.** This is a custom protocol built from standard browser primitives
- [ ] **Files and images are not end-to-end encrypted**
- [ ] **No forward secrecy per message,** and no key transparency. See the security model for the full list of limits
- [ ] **Existing conversations are not converted.** Only conversations started after someone sets up encryption are encrypted
- [ ] **Server-side search can't cover encrypted conversations.** They're searched on the device, among opened messages
- [ ] **Real phones and slow networks** haven't been tried. The passphrase step uses 600,000 PBKDF2 rounds, which is slower on older phones

### Failure recovery

Simulated against the production build with real processes: Redis wiped, restarted, down while running and down at boot;
MongoDB down while running and down at boot; the app killed abruptly. Deadlines fired, messages flowed where they could,
and everything recovered by itself. Graceful `SIGTERM` shutdown isn't covered, because the runs were on Windows.

## Partially completed

| Feature | State | What's left |
| --- | --- | --- |
| **Cloudinary** | Implemented behind the provider interface | **Never run.** No credentials. Needs a live test |
| **Web Push** | Server, service worker and opt-in written | **Never delivered a real push.** Delivery logic is tested with a stand-in sender |
| **Docker image** | Dockerfile and compose written, with a CI build job | **Never built.** Docker isn't available here, and CI hasn't run yet |
| **Free staging on Render** | `render.yaml` written. Same build commands and production settings booted locally, 123 MB at idle | **Never deployed.** Needs Atlas, Cloudinary and a Render account |
| **CI** | GitHub Actions workflow written | **Never run.** It runs once this reaches GitHub |
| **PWA install** | Manifest, icons and offline start are tested | The install prompt itself hasn't been tried |
| **Mobile** | Emulated phone covered | No real device. Touch dragging on the Canvas untested. Keyboard and mouse dragging are tested |
| **Accessibility** | Automated audit, keyboard Canvas reorder, dialog focus traps | Automated tools catch only part of the problem. No screen reader testing yet |

## Pending

| Item | Notes |
| --- | --- |
| Gemini ecosystem research | **Not received.** Requirements come from the brief alone |
| Email verification and password reset | Needs an email provider. Also the only recovery for a forgotten account password, which is separate from the encryption passphrase, and which can't be recovered at all |
| Two-factor authentication | |
| Abuse reporting and moderation | |
| Upload malware scanning | |
| Account deletion and data export | |
| External penetration test | Should happen before public launch |
| Independent review of the encryption protocol | Should happen before anyone relies on it against a capable attacker |
| Encrypted attachments | Needs client-side encryption before upload, and changes to media validation |
| Upgrade an existing conversation to encrypted | Not offered. New conversations only |

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
| A Redis wipe or restart stopped all deadlines and digests until the app restarted | Failure simulation | **High** |
| The app wouldn't start while Redis was down | Failure simulation | **High** |
| With Redis down, sending failed and sign-in hung for over 20 seconds | Failure simulation | **High** |
| A failed Socket.IO publish during a Redis outage crashed the process | Failure simulation, after the fix above | **High** |
| With reduced motion, every press left a ripple element behind in the button | Browser test | Low |
| Button motion styles overrode `absolute`, so the phone message menu took up its own line | Reviewing screenshots | Low |
| Encrypting a key version could leave a room with no usable key if the request was refused after the version moved | Encryption server tests | **High** |
| A forgotten wait in a test navigated away mid-send, which looked like an encryption failure | Repeating the browser tests | Low |
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
