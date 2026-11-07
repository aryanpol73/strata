# Data model

MongoDB via Mongoose. The source of each runtime shape is `packages/shared`. Models live in `apps/server/src/models`.

## Identity

**User**: `email` (unique, lowercased), `passwordHash` (argon2id), `displayName`, `handle` (unique), `avatarUrl`, `bio`.

**DeviceSession**: `userId`, `tokenHash`, `prevTokenHash`, `rotatedAt`, `deviceName`, `userAgent`, `ip`, `lastSeenAt`,
`expiresAt`, `revokedAt`, `revokeReason`.
Indexes: `{tokenHash}`, `{prevTokenHash}`, `{userId, revokedAt}`, TTL on `expiresAt`.

**Personas** are not modelled yet. All sender references go through a `{type, id}` principal, so they can be added later
without changing the message schema.

## Conversations

**Room**: `kind` (`direct|group|branch`), `name`, `avatarUrl`, `directKey` (sorted user pair, unique sparse), `rev`,
`lastMessage` (preview), `createdBy`, `settings {blockingAck: admins|members}`, and for branches: `parentRoomId`,
`parentMessageId`, `rootRoomId`, `depth`, `branch {title, status, visibility, transcriptPolicy, resolution, mergedAt,
mergedMessageId}`.
Indexes: `{directKey}` unique sparse, `{parentRoomId, 'branch.status'}`, `{parentMessageId}`.

**RoomMember**: `roomId`, `userId`, `role` (`owner|admin|member`), `lastDeliveredSeq`, `lastReadSeq`, `mutedUntil`,
`joinedAt`, `leftAt`.
Indexes: `{roomId, userId}` unique, `{userId, leftAt}`.

**Message**: `roomId`, `seq`, `rev`, `sender {type: user|guest|system, id, name}`, `clientMessageId`,
`type` (`text|media|block|resolution|system`), `payload` (zod discriminated union), `replyTo {messageId, seq, excerpt, senderName}`,
`reactions [{emoji, principalIds}]`, `posture`, `editedAt`, `deletedAt`, `searchText`, `branchCount`, `refCount`.
Indexes: `{roomId, seq}` unique, `{roomId, rev}`, `{roomId, sender.id, clientMessageId}` unique partial, text on `searchText`.

## Guests

**GuestCapability**: `roomId` (always a branch), `createdBy`, `tokenHash`, `label`, `scope {write, blocks, canvas}`,
`pinHash`, `pinAttempts`, `lockedUntil`, `expiresAt`, `revokedAt`, `redemptions`.
Indexes: `{tokenHash}` unique, `{roomId, revokedAt}`.

**GuestSession**: `capabilityId`, `roomId`, `displayName`, `secretHash`, `lastSeenAt`, `expiresAt`, `revokedAt`.
Indexes: `{secretHash}` unique, `{capabilityId}`, TTL on `expiresAt`.

## Collaborative state

**Block**: `roomId`, `messageId`, `type`, `createdBy`, `policy {edit: everyone|creator}`, `snapshot` (Binary),
`snapshotSeq`, `seq`, `summary` (derived JSON for previews, search and Canvas), `archivedAt`.
Indexes: `{roomId}`, `{messageId}`.

**BlockUpdate**: `blockId`, `seq`, `update` (Binary), `clientUpdateId`, `actor`.
Indexes: `{blockId, seq}` unique, `{blockId, clientUpdateId}` unique.

**BlockActivity**: `blockId`, `actor`, `action`, `detail`, `at`. Survives compaction, unlike raw updates.
Index: `{blockId, at}`.

## Knowledge layer

**CanvasDocument**: `roomId` (unique), `sections [{id, title, order}]`.

**CanvasBlock**: `roomId`, `sectionId`, `order` (fractional key), `kind` (`text|link|decision|quote|live`), `content`,
`source {messageId, roomId, seq, senderName, excerpt, sentAt}`, `liveBlockId`, `version`, `createdBy`, `updatedBy`, `deletedAt`.
Indexes: `{roomId, deletedAt, sectionId, order}`, `{'source.messageId'}`.

**MessageCitation**: the edge table for bidirectional references. `fromKind` (`canvas|message|branch`), `fromId`,
`fromRoomId`, `toMessageId`, `toRoomId`, `createdBy`.
Indexes: `{toMessageId}`, `{fromKind, fromId, toMessageId}` unique.

Citations are filtered per reader on every read. An edge from a branch you can't see is simply omitted.

## Attention

**NotificationPreference**: `userId` (unique), `timezone` (IANA), `digestWindows ['09:00','17:30']`,
`quietHours {enabled, start, end}`, `blockingBypassesQuiet`, `channels {push, inApp}`,
`rules [{id, roomId?, senderId?, posture?, action: deliver|digest|mute}]`.

**Notification**: `userId`, `roomId`, `messageId`, `posture`, `digest`, `state`, `dueAt`, `attempts`, `leaseUntil`, `sentAt`,
`readAt`, `reason`, `title`, `body`, `kind` (`message|ack_reminder|ack_expired|digest`), `digestCount`.
States: `pending -> sent | suppressed | failed`.
Indexes: `{state, dueAt}`, `{userId, state}`, `{messageId, userId, kind}` unique.

**AckContract**: `messageId` (unique), `roomId`, `senderId`, `deadline`, `required [userId]`, `acks [{userId, at}]`,
`state` (`open|satisfied|expired`), `reminderAt`, `reminderSentAt`.
Indexes: `{state, deadline}`, `{state, reminderAt}`, `{roomId}`.

**PushSubscription**: `userId`, `endpoint` (unique), `keys`, `failures`.

## Media

**MediaAsset**: `roomId`, `uploaderId`, `provider` (`cloudinary|disk`), `key`, `mime`, `bytes`, `width`, `height`, `name`,
`status` (`pending|ready`).
Indexes: `{roomId}`, `{provider, key}` unique, TTL-style cleanup of stale `pending` rows.

## Encryption

| Collection | Holds | Notes |
| --- | --- | --- |
| `users.e2ee` | Public key, and the passphrase-protected private key backup | Null until set up. The backup is ciphertext |
| `rooms.encrypted`, `keyVersion`, `needsRotation` | Whether messages are encrypted, the current key version, and whether a new one is due | `needsRotation` is set when someone leaves |
| `roomkeys` | One room key version sealed to one member | Unique on `(roomId, userId, version)`. Insert-only, never overwritten. Deleted for people who leave and for replaced identities |
| `messages.payload` | `{ type: 'encrypted', kv, iv, ct }` for encrypted conversations | `searchText` stays empty |
| `settings` | Server-wide values, such as the generated push keys | Shared by every node |

## Invariants

1. A `RoomMember` of a branch must be an active member of its parent. Leaving a room cascades to its branches.
2. `message.seq` is unique per room and never reused.
3. A guest capability only ever references a room where `kind = branch`.
4. Replies only reference messages in the same room, which keeps branch content from crossing a boundary.
5. A branch can merge exactly once. `mergedMessageId` is written with a conditional update.
6. Canvas and citation sources only come from rooms the actor can read.

- An encrypted room never holds a plaintext text message, and a plain room never holds an encrypted one.
- A room key version exists once. A request that creates it is refused unless it includes a copy for its own author.
- Nothing in these collections can be turned into message text without a person's private key.
