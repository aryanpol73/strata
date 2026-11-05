# Product requirements

**Philosophy:** conversations should crystallize, not evaporate.

Every feature serves at least one pillar: **Communication**, **Collaboration**, **Context**, **Attention**.

> **Inputs still outstanding.** The brief mentions Gemini's ecosystem research and separate UI references. Neither
> has been supplied yet. This document is derived from the brief alone. The design tokens in
> `apps/web/src/styles` are kept in one place so that visual references can be applied without restructuring.

## Requirements by priority

`P0` defines the product. `P1` is the foundation everything else stands on. `P2` is deferred by design.

### Signature features (P0)

| ID | Feature | Acceptance criteria |
| --- | --- | --- |
| BR-1 | Create a branch from a message | Any member with access to the message can branch it, choosing a title, participants and visibility |
| BR-2 | Scoped history | A branch has its own messages. The parent is never modified, apart from a branch marker and the final card |
| BR-3 | Lifecycle | `open`, `resolved`, `archived`, with transitions enforced server-side |
| BR-4 | Merge | Resolving records a summary. Merging posts one resolution card to the parent, exactly once |
| BR-5 | Navigation | Parent message links to its branch, and the branch links back, for authorized readers only |
| BR-6 | Visibility rules | See the matrix below, enforced on the server, tested with non-participants |
| LB-1 | Three block types | Checklist, sign-up roster, shared information card |
| LB-2 | CRDT sync | Concurrent edits converge. One message per block, regardless of the number of edits |
| LB-3 | Persistence | Updates are durable before acknowledgement, with snapshot compaction |
| LB-4 | Recovery | A client that was offline reconciles on reconnect, without losing edits |
| LB-5 | Permissions and history | Per-block edit policy, enforced on the server. Readable change history |
| CV-1 | Canvas per room | Desktop: collapsible right panel. Mobile: its own view |
| CV-2 | Extraction | Any message can become a Canvas block, which keeps a source reference |
| CV-3 | Organization | Sections, drag reorder, inline editing. Text, link, decision, quote, and live-block kinds |
| CV-4 | Bidirectional navigation | Canvas block to message, and message to Canvas block |
| GB-1 | Guest link | Secure link into exactly one branch. No install, no account |
| GB-2 | Controls | Read or write scope, optional PIN, expiry, instant revocation, rate limiting |
| GB-3 | Isolation | A guest can never reach the parent room or any other room. Tested adversarially |
| DL-1 | Four postures | WHISPER, DIGEST, STANDARD and BLOCKING ACK as server-side policies |
| DL-2 | Preferences | Timezone, digest windows, quiet hours, rules |
| DL-3 | Background processing | Durable scheduling, retries, visible failure states |
| DL-4 | Acknowledgement | Deadlines, sender visibility of who has and hasn't acknowledged, expiry handling |

### Branch visibility matrix

| Who | `listed` branch | `private` branch |
| --- | --- | --- |
| Branch participant | Everything | Everything |
| Parent member, not a participant | Title, status, participant count, resolution once merged | Nothing until merged, then the resolution card only |
| Parent member, after merge with `transcriptPolicy: parent_members` | Read-only transcript | Read-only transcript |
| Guest on this branch | This branch's messages only. No parent data, no member emails | Same |
| Anyone else | Nothing, and the API answers 404 rather than 403 | Same |

### Foundation (P1)

Accounts, profiles, device sessions, direct and group rooms, real-time delivery, media, replies, reactions, edit,
delete, search, presence, typing, delivery and read receipts, group management.

### Future (P2, not built in the MVP)

Decision Ledger, Time-Scrubber, Voice Chapters, Symmetrical Attention, Entity Drawer, Ghost Bubbles,
Multi-Persona Identity, Shadow Scribe, Spatial Audio, Slow-Pact Rooms, Micro-Applets, Cascade Redaction.

`docs/02-architecture.md` lists the extension point that each of these will use.

## Semantics that are easy to get wrong

**Delivery is not notification.** Every message is persisted and pushed to connected clients regardless of posture.
The posture controls only whether, and when, the recipient is *interrupted*. A whisper is always in the conversation.

| Posture | Message in conversation | Counts as unread | Interrupts |
| --- | --- | --- | --- |
| WHISPER | Immediately | Quietly (no badge alert) | Never |
| DIGEST | Immediately | Yes | Once, in the recipient's next digest window |
| STANDARD | Immediately | Yes | Now, or when quiet hours end |
| BLOCKING ACK | Immediately | Yes, until acknowledged | Now, with a reminder before the deadline |

**The recipient has the last word.** The sender declares intent, and recipient rules decide the outcome. A sender
cannot use a posture to override a recipient's mute. BLOCKING ACK may pass through quiet hours only if the recipient
allows it, and sending one is rate limited so it can't become a harassment tool.

## Non-goals

- End-to-end encryption. Messages are readable by the server, and Strata does not claim otherwise.
- Voice or video calls.
- Replacing a project-management tool. Blocks stay deliberately small.
