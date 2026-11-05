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

## Media

- The server signs uploads, and bytes go directly to Cloudinary, or to an authenticated local endpoint in development.
- Allowlist of MIME types. SVG and HTML are refused. Size limits are enforced in the signature and at completion.
- The disk provider checks magic bytes and serves with `nosniff` and `Content-Disposition`.
- Cloudinary assets use `type=authenticated`. Delivery URLs are signed, short-lived, and issued only after a room check.

## Block update validation

Yjs updates are opaque binary and arrive from clients. Each one is size-limited, decoded on a copy of the document, and
checked by the block type's validator before persistence. Malformed or forbidden updates are rejected and not relayed.

## Encryption

**Strata is not end-to-end encrypted.** TLS protects transport. Encryption at rest depends on the MongoDB and Redis
deployment. The server can read message content, and needs to for search, previews, and notifications. Strata will not
claim otherwise unless an established protocol is implemented and independently reviewed.

## Privacy implications

| Area | Implication |
| --- | --- |
| Server-side processing | Message text is stored in plaintext and indexed for search. Operators with database access can read it |
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
- No rate limit on Yjs updates over the socket. They are size-limited and validated, but an authorized member could flood a block.
- No two-factor authentication.
- No malware scanning of uploads.
- No moderation or abuse reporting.
- No formal data export or account deletion flow.
- A third-party penetration test has not been performed.
