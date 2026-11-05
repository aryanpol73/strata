import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import type { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { ClientToServerEvents, MessageDTO, RoomDTO, ServerToClientEvents } from '@strata/shared';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface TestUser {
  id: string;
  token: string;
  cookie: string;
  name: string;
  handle: string;
  email: string;
  sessionId: string;
}

export interface Harness {
  http: HttpServer;
  io: Server;
  url: string;
  api: () => ReturnType<typeof request>;
}

function configureEnv(dbName: string, redis: boolean) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: `${process.env.TEST_MONGO_URI!.replace(/\/?$/, '/')}${dbName}`,
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-signing',
    MEDIA_SIGNING_SECRET: 'another-test-secret-long-enough-for-media-urls',
    RATE_LIMITS_ENABLED: 'false',
    MEDIA_DIR: mkdtempSync(path.join(tmpdir(), 'strata-media-')),
    CORS_ORIGINS: 'http://localhost:5173',
    LOG_LEVEL: 'silent',
  });
  if (redis) process.env.REDIS_URL = process.env.TEST_REDIS_URL;
  else delete process.env.REDIS_URL;
}

/** Boots the real app, gateway and database for a test file. Modules load afterwards, so that env is set first. */
export function useHarness(options: { redis?: boolean; rateLimits?: boolean } = {}) {
  const harness = {} as Harness;
  const opened: ClientSocket[] = [];

  beforeAll(async () => {
    const dbName = `strata_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    configureEnv(dbName, options.redis ?? false);
    if (options.rateLimits) process.env.RATE_LIMITS_ENABLED = 'true';

    const { resetEnv, getEnv } = await import('../src/config/env.js');
    resetEnv();
    const { createApp } = await import('../src/app.js');
    const { createGateway } = await import('../src/realtime/gateway.js');

    await mongoose.connect(getEnv().MONGODB_URI);
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));

    const http = createServer(createApp());
    harness.http = http;
    harness.io = createGateway(http) as unknown as Server;
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    harness.url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    harness.api = () => request(http);
  });

  beforeEach(() => {
    opened.splice(0).forEach((s) => s.disconnect());
  });

  afterAll(async () => {
    opened.forEach((s) => s.disconnect());
    const { hub } = await import('../src/realtime/hub.js');
    const { closeRedis } = await import('../src/lib/redis.js');
    hub.detach();
    await harness.io.close();
    await closeRedis();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  return Object.assign(harness, {
    track(socket: ClientSocket) {
      opened.push(socket);
      return socket;
    },
  });
}

let counter = 0;

export async function makeUser(h: Harness, name = 'User'): Promise<TestUser> {
  counter += 1;
  const handle = `${name.toLowerCase().replace(/\W/g, '')}_${counter}_${Date.now() % 100000}`.slice(0, 24);
  const email = `${handle}@example.test`;
  const res = await h.api().post('/api/auth/register').send({ email, password: 'correct horse battery', displayName: name, handle });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return {
    id: res.body.user.id,
    token: res.body.accessToken,
    cookie: String(res.headers['set-cookie']?.[0]).split(';')[0]!,
    sessionId: res.body.sessionId,
    name,
    handle,
    email,
  };
}

export const as = (user: { token: string }) => ({ Authorization: `Bearer ${user.token}` });

export async function makeGroup(h: Harness, owner: TestUser, members: TestUser[], name = 'Team'): Promise<RoomDTO> {
  const res = await h.api().post('/api/rooms/group').set(as(owner)).send({ name, memberIds: members.map((m) => m.id) });
  if (res.status !== 201) throw new Error(`group failed: ${JSON.stringify(res.body)}`);
  return res.body.room;
}

export async function send(h: Harness, user: TestUser, roomId: string, text: string, extra: object = {}): Promise<MessageDTO> {
  const res = await h
    .api()
    .post(`/api/rooms/${roomId}/messages`)
    .set(as(user))
    .send({ clientMessageId: randomUUID(), content: { type: 'text', text }, ...extra });
  if (res.status >= 300) throw new Error(`send failed: ${JSON.stringify(res.body)}`);
  return res.body.message;
}

export async function socketFor(h: Harness & { track: (s: ClientSocket) => ClientSocket }, token: string): Promise<ClientSocket> {
  const socket = h.track(connect(h.url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  // The server joins channels asynchronously after connect.
  await sleep(120);
  return socket;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves with the next event of this name, or rejects after a timeout. */
export function nextEvent<T>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    (socket as unknown as Socket).once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Records everything a socket receives, for asserting on what must NOT arrive. */
export function record(socket: ClientSocket): { event: string; payload: unknown }[] {
  const log: { event: string; payload: unknown }[] = [];
  socket.onAny((event: string, payload: unknown) => log.push({ event, payload }));
  return log;
}
