# Deployment

> The Dockerfile and compose file were written but **have not been built**, because Docker wasn't available in the
> development environment. The production bundle itself was smoke-tested directly with Node. Build the image once and
> check it before relying on it.

## What you need

| Service | Notes |
| --- | --- |
| Node 22+ host with **long-lived connections** | Serverless platforms can't hold WebSockets |
| MongoDB 6+ | MongoDB Atlas works. A replica set isn't required for correctness |
| Redis 6.2+ | Required in production. Don't enable eviction, because BullMQ needs its keys kept |
| Cloudinary | For media. See below |
| TLS terminator | Required. Refresh cookies are `Secure` |

## Processes

Run one image in two roles, so that scaling the API doesn't multiply background work:

| Role | Command | Scale |
| --- | --- | --- |
| API | `ROLE=api node dist/main.js` | Horizontally |
| Worker | `ROLE=worker node dist/main.js` | One or more. Work is claimed atomically, so extras are safe |

`ROLE=all` runs both in one process, which suits small deployments.

## Configuration

`.env.example` documents every variable. Production refuses to start unless:

- `REDIS_URL` is set
- `APP_URL` uses https
- `CORS_ORIGINS` has no wildcard
- `JWT_SECRET` and `MEDIA_SIGNING_SECRET` are different, and at least 32 characters
- Cloudinary credentials are present, if that provider is selected

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Keep secrets in your platform's secret store. Rotating `JWT_SECRET` signs everyone out of their current access token,
and they recover through their refresh cookie.

## Reverse proxy

- Set `TRUST_PROXY_HOPS` to the exact number of proxies. Too high lets clients spoof their IP and dodge rate limits.
- Forward WebSocket upgrades for `/socket.io`.
- Allow request bodies of 25 MB on `/api/media`, if using the disk provider.

### More than one API node

The client tries WebSocket first and can fall back to long-polling. Polling needs **sticky sessions**, so either enable
them on your load balancer, or set the client to `transports: ['websocket']` in `apps/web/src/realtime/socket.ts`.

## Serving the web client

Either set `WEB_DIST` to the built `apps/web/dist` and let the API serve it, which gives you the CSP in `app.ts`, or put
it on a CDN. With a CDN on another origin you'd need to add that origin to `CORS_ORIGINS`, and the `SameSite=Strict`
cookies mean API and client must still share a site.

## Media with Cloudinary

**Not yet verified against a live account.** The integration is complete, but no credentials were available.

1. Set `MEDIA_PROVIDER=cloudinary` and the three `CLOUDINARY_*` variables.
2. In Cloudinary settings, restrict unsigned uploads, and keep strict transformations on.
3. Upload a file through the app and confirm that it's stored as type `authenticated`.
4. Confirm the raw Cloudinary URL fails without a signature.

Note that `disk` storage doesn't work with more than one API node, unless `MEDIA_DIR` is a shared volume.

## Web Push

**Not yet verified with a real browser subscription.**

```bash
pnpm --filter @strata/server exec web-push generate-vapid-keys
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`. People then opt in from Settings. Without these keys,
in-app notifications still work.

## Operations

| Task | Approach |
| --- | --- |
| Health | `GET /api/health` returns 503 when MongoDB is unreachable |
| Logs | JSON on stdout, through pino. Tokens and passwords are redacted |
| Backups | Back up MongoDB. It's the source of truth. Redis holds nothing that can't be rebuilt |
| Redis loss | Safe. Delivery state lives in MongoDB, and the next sweep finds whatever is due |
| Shutdown | SIGTERM drains sockets and workers |
| Indexes | Mongoose builds them on start. For large collections, build them ahead of a deploy instead |

## Before opening to the public

See "Known gaps before public launch" in the [security model](./05-security-model.md). In particular: email
verification, password reset, abuse reporting, upload malware scanning, and an external penetration test.
