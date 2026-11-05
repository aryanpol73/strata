# API and Socket.IO contracts

Request and response shapes are defined once, as zod schemas in `packages/shared`.

## Conventions

- Base path `/api`. JSON. Bearer access token, except for cookie-based refresh endpoints.
- **Errors**: `{ "error": { "code": "BRANCH_NOT_OPEN", "message": "...", "details": {} } }` with a real HTTP status.
- **Hidden resources return 404, not 403**, so a caller can't confirm that a private branch exists.
- **Pagination**: messages use `?beforeSeq=&limit=` (max 100). Other lists use an opaque `cursor`.
- **Idempotency**: `clientMessageId` for messages, `clientUpdateId` for block updates. Retrying returns the first result.
- **Cookie endpoints** require the `X-Strata-Client: web` header, in addition to `SameSite=Strict`, as CSRF defence.

## REST

### Auth and sessions
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/register` | Create account, start a session |
| POST | `/auth/login` | Start a session |
| POST | `/auth/refresh` | Rotate the refresh cookie, return an access token |
| POST | `/auth/logout` | Revoke the current session |
| GET | `/auth/sessions` | List device sessions |
| DELETE | `/auth/sessions/:id` | Revoke a device, and disconnect its sockets |

### Users
`GET /users/me`, `PATCH /users/me`, `GET /users/search?q=` (exact handle or prefix, minimum 2 characters), `GET /users/:id`
(only for people you share a room with).

### Rooms
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/rooms` | My rooms with unread counts |
| POST | `/rooms/direct` | Find or create a direct room |
| POST | `/rooms/group` | Create a group |
| GET | `/rooms/:id` | Room details and members |
| PATCH | `/rooms/:id` | Rename, change settings |
| POST | `/rooms/:id/members` | Add members |
| PATCH | `/rooms/:id/members/:userId` | Change role |
| DELETE | `/rooms/:id/members/:userId` | Remove, or leave |
| POST | `/rooms/:id/read` | Advance the read watermark |
| PATCH | `/rooms/:id/mute` | Mute until a time |

### Messages
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/rooms/:id/messages` | Page backwards by `beforeSeq`, or jump with `aroundSeq` |
| GET | `/rooms/:id/sync?sinceRev=` | Everything changed since a revision |
| POST | `/rooms/:id/messages` | Send (idempotent) |
| PATCH | `/messages/:id` | Edit own text |
| DELETE | `/messages/:id` | Tombstone |
| POST | `/messages/:id/reactions` | Toggle a reaction |
| GET | `/messages/:id/references` | Citations, filtered for the reader |
| POST | `/messages/:id/ack` | Acknowledge a BLOCKING ACK |
| GET | `/messages/:id/delivery` | Delivery status, sender only |
| GET | `/search?q=&roomId=` | Search across readable rooms |

### Branches
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/messages/:id/branches` | Create a branch from a message |
| GET | `/rooms/:id/branches` | Branches visible to me |
| POST | `/branches/:id/participants` | Add participants (must be parent members) |
| POST | `/branches/:id/resolve` | Set status to resolved, with a summary |
| POST | `/branches/:id/reopen` | Back to open, unless merged |
| POST | `/branches/:id/merge` | Post the resolution card to the parent, once |
| POST | `/branches/:id/archive` | Archive |

Branch actions return `{ branch }`, not a room, because a parent admin can manage a listed branch without being in it.

### Guest bridges (member side)
`POST /branches/:id/guest-links`, `GET /branches/:id/guest-links`, `DELETE /guest-links/:id`.

### Guest API (guest token only)
| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/guest/redeem` | Exchange link token, PIN and display name for a session |
| POST | `/guest/token` | New short-lived token from the guest cookie |
| GET | `/guest/room` | Sanitized room view |
| GET | `/guest/messages` | Paged messages for the scoped room |
| POST | `/guest/messages` | Send, requires write scope |
| GET | `/guest/sync` | Changes since a revision |
| GET | `/guest/canvas` | Read-only Canvas, requires canvas scope |
| GET | `/guest/media/:id/url` | Signed link, for files in the scoped room only |
| POST | `/guest/leave` | End the guest session |

Room id never appears in guest paths, because it comes from the capability.

### Blocks
`POST /rooms/:id/blocks` (creates the block and its message), `GET /blocks/:id`, `GET /blocks/:id/activity`,
`PATCH /blocks/:id/policy`.

### Canvas
| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/rooms/:id/canvas` | Document, sections and blocks |
| POST | `/rooms/:id/canvas/sections` | Add a section |
| PATCH/DELETE | `/rooms/:id/canvas/sections/:sectionId` | Rename, delete |
| POST | `/rooms/:id/canvas/blocks` | Add a block, optionally from a message |
| PATCH | `/canvas/blocks/:id` | Edit, requires `version` |
| POST | `/canvas/blocks/:id/move` | Reorder, or change section |
| DELETE | `/canvas/blocks/:id` | Remove |

### Attention and media
`GET/PUT /notifications/preferences`, `GET /notifications`, `GET /notifications/needs-you` (acknowledgements still
waiting on me), `POST /notifications/read`,
`GET /notifications/push-key`, `POST /notifications/push-subscriptions`, `DELETE /notifications/push-subscriptions`,
`POST /media/sign`, `POST /media/:id/complete`, `GET /media/:id/url`.

## Socket.IO

Connect with `auth: { token }`. Member and guest tokens are distinguished by audience.

### Server to client
| Event | Payload | Guest? |
| --- | --- | --- |
| `message:new` | `{ message }` | Yes |
| `message:updated` | `{ message }`: edit, delete, reaction | Yes |
| `room:updated` | `{ room }` | Sanitized |
| `room:joined` / `room:left` | `{ roomId }` | No |
| `member:updated` | `{ roomId, userId }` | No |
| `receipt` | `{ roomId, principalId, deliveredSeq, readSeq }` | No |
| `typing` | `{ roomId, principalId, name, active }` | Yes |
| `presence` | `{ userId, online }` | No |
| `branch:updated` | `{ roomId, branch }` | Status and title only |
| `block:update` | `{ blockId, seq, update }` | With block scope |
| `canvas:changed` | `{ roomId, kind, ... }` | With canvas scope |
| `notification:new` | `{ notification }` | No |
| `ack:updated` | `{ messageId, contract }` | No |
| `session:revoked` | `{ reason }` | Yes |

### Client to server (each takes an ack callback)
| Event | Payload | Result |
| --- | --- | --- |
| `typing` | `{ roomId, active }` | Throttled, ephemeral |
| `receipt:delivered` | `{ roomId, seq }` | Advances the watermark |
| `block:join` | `{ blockId, stateVector }` | `{ diff, stateVector, canEdit }` |
| `block:update` | `{ blockId, update, clientUpdateId }` | `{ seq }` after persistence |

## Ordering guarantees

- Within a room, `seq` is strictly increasing and `rev` strictly increases with each change.
- Socket events may arrive out of order across nodes. Clients apply `message:updated` only if `rev` is newer, and
  sort by `seq`.
- After any reconnect, the client calls `/sync` with its highest known `rev` for each active room.

## Authorization summary

All checks use `apps/server/src/modules/access`.

| Action | Rule |
| --- | --- |
| Read a room | Active member, or a parent member of a merged branch with an opened transcript |
| Send | Active member. The branch must be `open` |
| Edit or delete a message | Own message. Admins may also delete |
| Manage members | Owner or admin. Direct rooms are fixed |
| Branch lifecycle | Branch creator, or parent admin |
| Create a guest link | A branch participant |
| Blocking ACK | Allowed by the room's `settings.blockingAck`, and rate limited |
| Block edit | Room read and write access, and the block's policy, and type validation |
