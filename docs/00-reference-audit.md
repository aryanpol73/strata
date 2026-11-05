# Reference repository audit

**Subject:** `gauravnandre/Chat-App`, commit `4858b81` (2026-11-02). 76 tracked files, about 920 lines of
React plus a small Express server.

**Licence:** no licence file and no licence metadata. Under default copyright this code is **not reusable**.
Strata uses it only as an architectural reference. No source, UI, layout, or branding was copied.

## What it is

A two-party chat demo: React (Vite, JSX) with context-based state, Express 5, Mongoose, and Socket.IO, with
Cloudinary for images.

| Area | Implementation |
| --- | --- |
| Frontend | `AuthContext` and `ChatContext`, three pages, three large components, axios, `react-hot-toast` |
| Auth | bcrypt, one non-expiring JWT in `localStorage`, sent in a custom `token` header |
| Models | `User`, `Message {senderId, receiverId, text, image, seen}`. No concept of a room |
| Messaging | REST send, then `io.to(socketId).emit("newMessage")` |
| Sockets | In-process `userSocketMap {userId: socketId}`, user id taken from the query string |
| Media | Base64 inside a JSON body (10 MB limit), proxied through the server to Cloudinary |
| Users | Sidebar lists every user in the database |

## Findings

### Critical (Strata must not repeat these)

1. **Secrets are committed.** `server/.env` is tracked and holds `MONGODB_URI`, `JWT_SECRET` and the Cloudinary
   secret keys. Values were deliberately not read during this audit. The owner should rotate them.
2. **Sockets are unauthenticated.** `socket.handshake.query.userId` is trusted, so anyone can claim to be any
   user and receive that user's messages.
3. **IDOR on read state.** `PUT /mark/:id` lets any logged-in user mark any message as seen. There is no
   ownership check.
4. **Tokens never expire.** `JWT.sign({userId}, secret)` has no `exp`. With no refresh or revocation, a stolen
   token is valid forever, and `localStorage` exposes it to any XSS.
5. **Password hash leak.** `signup` and `login` return the full user document, including `password`.
6. **User enumeration.** `getUsersForSidebar` returns every account to every user.
7. **Open CORS and no rate limiting.** `origin: "*"` everywhere, no brute-force protection on login.

### Correctness bugs

- The socket listens for `"Disconnect"` (capital D). That event never fires, so users are never removed from
  presence.
- `userSocketMap` keeps one socket per user, so a second tab or device silently replaces the first.
- Failed login returns `success: true` with an error message.
- `login` dereferences a null user for unknown emails, so the failure reaches the catch block as a raw
  `TypeError` message. That also distinguishes unknown accounts from wrong passwords.
- Schema typo: `require: true` instead of `required`, so the message fields are not actually required.
- `getMessages` has a side effect (marks everything seen) on a GET.
- Failures return HTTP 200 with `success: false`, which breaks retries and monitoring.

### Scalability limits

- `getMessages` has no pagination, and there are no indexes on `senderId`/`receiverId`.
- The unread count is an N+1 query that loads whole documents to count them.
- In-memory presence cannot span more than one process.
- Base64 uploads consume server memory and bandwidth.
- `vercel.json` deploys the server as a serverless function, which cannot hold WebSocket connections.
- `server.js` and `messageController.js` import each other in a cycle.

## What Strata keeps, and what it replaces

| Concept | Reference | Strata |
| --- | --- | --- |
| Stack family | React, Express, Mongoose, Socket.IO | Same family, with TypeScript and a shared contract package |
| Conversation | Implicit sender/receiver pair | First-class `Room` with memberships. Branches are rooms too |
| Message | `text` and `image` columns | Polymorphic validated payload, per-room ordering, revision log |
| Read state | `seen` boolean per message | Per-member watermarks, O(members) rather than O(messages x members) |
| Real-time | Socket map | Authenticated sockets, Redis adapter, room channels, default-deny guest fan-out |
| Auth | Non-expiring JWT in `localStorage` | 15-minute JWT in memory, rotating HttpOnly refresh, device sessions |
| Media | Base64 via the server | Signed direct upload, access-controlled delivery |
