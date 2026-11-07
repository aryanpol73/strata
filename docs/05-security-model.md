# Security model

## Trust boundaries

1. **Browser to API.** Nothing from the client is trusted. All input passes zod validation.
2. **User to room.** One access module decides. Hidden resources answer 404.
3. **Guest to branch.** The critical boundary. Separate token audience, router, and socket channel.
4. **Server to third parties.** Cloudinary and push services receive only what they must.

## Authentication

| Item | Decision |
| --- | --- |
| Passwords | argon2id. Minimum 10 characters. Login takes the same time for unknown accounts, using a dummy hash |
| Access token | JWT, HS256, 15 minutes, `aud: strata:user`, carries `sid`. Held in memory on the client |
| Refresh token | 256-bit random, stored as a SHA-256 hash, `HttpOnly; Secure; SameSite=Strict; Path=/api/auth` |
| Rotation | Exactly one of any concurrent refreshes rotates. The others get an access token and leave the cookie alone. Replay of a superseded token outside a 10-second grace window revokes the session |
| Session check | Each request and socket connection confirms that `sid` is not revoked, so revocation is immediate rather than waiting for expiry |
| Revocation | `DELETE /auth/sessions/:id` also disconnects that session's sockets across all nodes |

## Guest bridges

**Threat:** a link leaks, or a guest tries to reach beyond the branch.

| Control | Implementation |
| --- | --- |
| Capability token | 256-bit random, stored hashed. Shown once at creation |
| Link format | Token sits in the URL fragment, so it stays out of server logs and `Referer` headers |
| PIN | Optional. argon2id. Five failures lock the link for 15 minutes |
| Expiry | Required, 7 days by default, 30 days maximum. Checked on every request |
| Revocation | Checked on every request. Sockets are disconnected at once |
| Rate limiting | Per IP on redemption, per session on sending |
| Isolation | Room id comes only from the capability, never from client input |
| Fan-out | Default-deny allowlist with sanitizers |
| Data minimization | Guests see display names only. No emails, no parent ids, no member list details |
| Replies and citations | Same-room only, so parent content can't be pulled into a branch by reference |

**Branch seeding:** a branch shows its origin message to members. Guests don't get that context, because the excerpt is
parent content. The inviter should describe the context in the branch itself.

## Authorization

- Enforced on the server, in `modules/access`, and tested with non-members, removed members, and guests.
- Socket handlers re-check membership on each privileged event. Being in a socket channel isn't proof of current access.
- When someone leaves a room, their sockets leave its channels on all nodes, and their branch memberships are removed.

## Web and transport

- `helmet` with a strict CSP. CORS allowlist from `CORS_ORIGINS`. No wildcards.
- JSON bodies limited to 256 KB. Media never passes through JSON.
- Mongo operator injection is prevented because zod rejects unexpected types.
- Message text is rendered by React as text, never as HTML.
- `trust proxy` is explicit configuration, so rate limits can't be bypassed by spoofing `X-Forwarded-For`.
- Secrets live only in the environment. Startup fails if they're missing or weak in production.

## Rate limits

Redis-backed in production: login, register, refresh, guest redeem, message send, blocking ACK, search, and media signing.

Socket writes aren't reached by HTTP limits, so each connection has its own token bucket covering block updates, block
joins and receipts. A rate-limited block edit is kept and retried by the client.

## Media

- The server signs uploads, and bytes go directly to Cloudinary, or to an authenticated local endpoint in development.
- Allowlist of MIME types. SVG and HTML are refused. Size limits are enforced in the signature and at completion.
- The disk provider checks magic bytes and serves with `nosniff` and `Content-Disposition`.
- Cloudinary assets use `type=authenticated`. Delivery URLs are signed, short-lived, and issued only after a room check.

## Block update validation

Yjs updates are opaque binary and arrive from clients. Each one is size-limited, decoded on a copy of the document, and
checked by the block type's validator before persistence. Malformed or forbidden updates are rejected and not relayed.

## Encryption

Text messages in direct conversations, groups and branches are **end-to-end encrypted**: they are encrypted in the browser
before they are sent, and the server stores only ciphertext. The server cannot read them, search them or put them in a
notification. This section says exactly what that does and doesn't cover.

**Read this too:** the construction uses standard primitives from the browser's own WebCrypto, but it is Strata's own
protocol. It is not Signal or MLS, and it **has not been independently reviewed**. It should be reviewed before anyone
relies on it against a capable attacker.

### How it works

| Piece | Construction |
| --- | --- |
| Identity | An ECDH P-256 key pair per person, made in the browser. The server holds the public key |
| Backup | The private key, encrypted with AES-256-GCM under a key derived from a passphrase with PBKDF2-SHA-256 (600,000 iterations). The server holds this blob and never the passphrase |
| Room key | A random AES-256-GCM key per conversation and version |
| Sharing a room key | For each member: ECDH with a throwaway key, HKDF-SHA-256, then AES-GCM. The room, person and version are bound in as authenticated data, so a copy can't be replayed elsewhere |
| Messages | AES-256-GCM with a random 96-bit IV, bound to the room and key version. Edits are re-encrypted |
| Rotation | When someone leaves, the room needs a new key version, which the remaining members' clients create. The person who left is never given it |
| Security codes | The SHA-256 of a public key, shown as six groups of digits, to compare in person or on a call |
| Key changes | Each device remembers the first key it saw for each person. If the server later presents a different one, nothing is shared with it until the person accepts it |

The server enforces what it can without seeing content: an encrypted conversation refuses plaintext messages and edits,
only members can add keys, only for current members, a key already shared is never overwritten, and a key version can
only be created once.

### What is not encrypted

- **Metadata.** Who is in a conversation, who sent each message, when, and its posture. Room names and branch titles.
- **Files and images.** Attachments are stored with the server's own protection, not end-to-end.
- **The Canvas, live blocks and resolution summaries.** The server has to read them to validate, merge and display them. Adding an encrypted message to the Canvas asks first, because it shows the server the text.
- **Guest branches.** A guest has no keys, so a branch that allows guests is created without encryption, and says so.
- **Notifications.** A push says who and where, never what. Titles contain the sender and conversation name.
- **Conversations from before encryption was set up.** They stay as they were, and say so in their header.

### Limits worth knowing

- **No forward secrecy per message.** Anyone who obtains a room key can read every message sealed with that version. Keys are replaced when someone leaves, not on a schedule.
- **A lost passphrase is unrecoverable.** Strata can't reset it. Old messages can only come back if another member of a conversation shares its keys again, which happens by itself after a reset.
- **First contact is trust on first use.** A malicious server could present a false key the first time two people meet. Comparing security codes defeats that, and Strata doesn't force anyone to.
- **A member can withhold or spoil keys.** Someone in a conversation could pre-store a useless key copy for another member. The result is that person being unable to read until the keys are replaced, not a leak.
- **Search is local.** Encrypted conversations are searched on the device, among messages already opened.
- **Keys sit in the browser's storage** while signed in, and are removed on sign-out. Cross-site scripting would be able to use them, which is why the Content Security Policy is strict.
- **TLS and database encryption still apply** to everything, and are what protect the items above that are not end-to-end.

## Privacy implications

| Area | Implication |
| --- | --- |
| Server-side processing | Encrypted conversations are stored as ciphertext. Everything listed under "What is not encrypted" is stored readable and, where it's text, indexed for search |
| Guests | A guest can read everything in the branch from before they joined, and can copy it. Inviters are told this in the UI |
| Guest data | Display name, hashed session secret, and IP-derived rate-limit counters. Sessions expire automatically |
| Shared blocks | Edits are attributed in history, and everyone with access can see who changed what |
| Branch metadata | A `listed` branch reveals title, status, and participant count to all parent members |
| Merged resolutions | Summaries become visible to the whole parent room, including text written with a smaller audience in mind |
| Canvas | Extraction copies an excerpt. Deleting the source message tombstones the source, but Canvas content stays until it is removed |
| Push | Payloads pass through browser vendor push services, so they contain a generic title rather than message text |
| Receipts and presence | Visible to room members. Controls for hiding them are not in the MVP |
| Deletion | Tombstones remove content, but backups may retain it for their retention period |

## Known gaps before public launch

- No email verification or password reset. Both need an email provider.
- No two-factor authentication.
- No malware scanning of uploads.
- No moderation or abuse reporting.
- No formal data export or account deletion flow.
- A third-party penetration test has not been performed.
