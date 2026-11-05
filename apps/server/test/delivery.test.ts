import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, type NotificationDTO, type RoomDTO } from '@strata/shared';
import { as, makeGroup, makeUser, nextEvent, send, sleep, socketFor, useHarness, type TestUser } from './helpers.js';

const h = useHarness({ redis: true });

let sender: TestUser;
let recipient: TestUser;
let room: RoomDTO;

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);
const deadline = (m: number) => inMinutes(m).toISOString();

async function models() {
  return { ...(await import('../src/models/delivery.js')), ...(await import('../src/modules/delivery/service.js')) };
}

const setPrefs = (user: TestUser, over: object) => h.api().put('/api/notifications/preferences').set(as(user)).send({ ...DEFAULT_PREFERENCES, ...over });

beforeEach(async () => {
  [sender, recipient] = await Promise.all([makeUser(h, 'Sender'), makeUser(h, 'Recipient')]);
  room = await makeGroup(h, sender, [recipient], 'Ops');
});

afterEach(async () => {
  const { resetPushSender, Notification, AckContract } = await models();
  resetPushSender();
  // Sweeps are global, so a test's leftovers mustn't reach the next one.
  await Notification.deleteMany({});
  await AckContract.deleteMany({});
});

describe('delivery is not notification', () => {
  it('every posture reaches the conversation immediately', async () => {
    const socket = await socketFor(h, recipient.token);
    for (const posture of ['whisper', 'digest', 'standard'] as const) {
      const heard = nextEvent<{ message: { posture: string } }>(socket, 'message:new');
      await send(h, sender, room.id, `a ${posture}`, { posture });
      expect((await heard).message.posture).toBe(posture);
    }
    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(recipient));
    expect(page.body.messages).toHaveLength(3);
  });

  it('a whisper creates no notification at all', async () => {
    const { Notification, sweep } = await models();
    const msg = await send(h, sender, room.id, 'psst', { posture: 'whisper' });
    await sweep();
    expect(await Notification.countDocuments({ messageId: msg.id })).toBe(0);
  });

  it('a whisper sends no interruption over the socket', async () => {
    const { sweep } = await models();
    const socket = await socketFor(h, recipient.token);
    let pinged = false;
    socket.on('notification:new', () => {
      pinged = true;
    });
    await send(h, sender, room.id, 'quiet', { posture: 'whisper' });
    await sweep();
    await sleep(100);
    expect(pinged).toBe(false);
  });

  it('standard interrupts promptly, with no scheduler tick needed', async () => {
    const { setSweepKick, sweep } = await models();
    setSweepKick(() => void sweep());
    const socket = await socketFor(h, recipient.token);
    const ping = nextEvent<{ notification: NotificationDTO }>(socket, 'notification:new');
    await send(h, sender, room.id, 'hello');
    const { notification } = await ping;
    expect(notification).toMatchObject({ title: 'Sender in Ops', body: 'hello', posture: 'standard' });
    setSweepKick(() => {});
  });

  it('never notifies the sender', async () => {
    const { Notification } = await models();
    const msg = await send(h, sender, room.id, 'hi');
    expect(await Notification.countDocuments({ messageId: msg.id, userId: sender.id })).toBe(0);
  });
});

describe('digests', () => {
  it('holds items until the window, then interrupts once', async () => {
    const { Notification, setPushSender, sweep } = await models();
    await send(h, sender, room.id, 'one', { posture: 'digest' });
    await send(h, sender, room.id, 'two', { posture: 'digest' });

    expect(await sweep()).toBe(0);

    const push = vi.fn(async () => {});
    setPushSender(push);
    const later = new Date(Date.now() + 2 * 86_400_000);
    await sweep(later);

    expect(push).toHaveBeenCalledTimes(1);
    const digest = await Notification.findOne({ userId: recipient.id, kind: 'digest' }).lean();
    expect(digest).toMatchObject({ digestCount: 2, state: 'sent' });
    const rows = await Notification.find({ userId: recipient.id, digest: true }).lean();
    expect(rows.every((r) => r.state === 'sent' && r.reason === 'delivered_in_digest')).toBe(true);
  });

  it('drops anything already read before the window', async () => {
    const { Notification, sweep } = await models();
    const msg = await send(h, sender, room.id, 'seen it', { posture: 'digest' });
    await h.api().post(`/api/rooms/${room.id}/read`).set(as(recipient)).send({ seq: msg.seq });
    await sweep(new Date(Date.now() + 2 * 86_400_000));
    const row = await Notification.findOne({ messageId: msg.id }).lean();
    expect(row).toMatchObject({ state: 'suppressed', reason: 'already_read' });
    expect(await Notification.countDocuments({ userId: recipient.id, kind: 'digest' })).toBe(0);
  });
});

describe('recipient preferences', () => {
  it('validates timezones and times', async () => {
    expect((await setPrefs(recipient, { timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await setPrefs(recipient, { digestWindows: ['25:00'] })).status).toBe(400);
    expect((await setPrefs(recipient, { timezone: 'Asia/Kolkata' })).body.preferences.timezone).toBe('Asia/Kolkata');
  });

  it('a muted room is suppressed, and the sender learns only that it was held', async () => {
    const { Notification } = await models();
    await h.api().patch(`/api/rooms/${room.id}/mute`).set(as(recipient)).send({ until: deadline(60) }).expect(204);
    const msg = await send(h, sender, room.id, 'hello?');
    expect(await Notification.findOne({ messageId: msg.id }).lean()).toMatchObject({ state: 'suppressed', reason: 'room_muted' });

    const status = await h.api().get(`/api/messages/${msg.id}/delivery`).set(as(sender));
    expect(status.body.status.recipients[0]).toMatchObject({ state: 'suppressed', reason: 'held_by_recipient' });
  });

  it('rules apply on the server', async () => {
    const { Notification } = await models();
    await setPrefs(recipient, { rules: [{ id: 'r', senderId: sender.id, action: 'digest' }] });
    const msg = await send(h, sender, room.id, 'routine');
    expect(await Notification.findOne({ messageId: msg.id }).lean()).toMatchObject({ digest: true, state: 'pending' });
  });

  it('quiet hours defer delivery, and the sender can see the delay', async () => {
    await setPrefs(recipient, { quietHours: { enabled: true, start: '00:00', end: '23:59' } });
    const msg = await send(h, sender, room.id, 'overnight');
    const res = await h.api().get(`/api/messages/${msg.id}/delivery`).set(as(sender));
    expect(res.body.status.recipients[0]).toMatchObject({ state: 'pending', reason: 'quiet_hours' });
    expect(new Date(res.body.status.recipients[0].dueAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('turning off in-app stops socket pings', async () => {
    const { sweep } = await models();
    await setPrefs(recipient, { channels: { push: false, inApp: false } });
    const socket = await socketFor(h, recipient.token);
    let pinged = false;
    socket.on('notification:new', () => {
      pinged = true;
    });
    await send(h, sender, room.id, 'hi');
    await sweep();
    await sleep(100);
    expect(pinged).toBe(false);
  });
});

describe('blocking acknowledgement', () => {
  const blocking = (minutes = 60) => ({ posture: 'blocking_ack', ackDeadline: deadline(minutes) });

  it('needs a deadline, in a sensible range', async () => {
    const post = (extra: object) =>
      h.api().post(`/api/rooms/${room.id}/messages`).set(as(sender)).send({ clientMessageId: randomUUID(), content: { type: 'text', text: 'x' }, posture: 'blocking_ack', ...extra });
    expect((await post({})).status).toBe(400);
    expect((await post({ ackDeadline: deadline(-5) })).status).toBe(400);
    expect((await post({ ackDeadline: deadline(60 * 24 * 60) })).status).toBe(400);
  });

  it('respects the room setting', async () => {
    await h.api().patch(`/api/rooms/${room.id}`).set(as(sender)).send({ blockingAck: 'admins' }).expect(200);
    const res = await h.api().post(`/api/rooms/${room.id}/messages`).set(as(recipient)).send({
      clientMessageId: randomUUID(),
      content: { type: 'text', text: 'x' },
      ...blocking(),
    });
    expect(res.status).toBe(403);
  });

  it('tracks who has acknowledged, and is satisfied when everyone has', async () => {
    const third = await makeUser(h);
    await h.api().post(`/api/rooms/${room.id}/members`).set(as(sender)).send({ userIds: [third.id] });
    const msg = await send(h, sender, room.id, 'Read the runbook', blocking());
    expect(msg.ack).toMatchObject({ state: 'open', ackedIds: [] });
    expect(msg.ack!.requiredIds.sort()).toEqual([recipient.id, third.id].sort());

    const first = await h.api().post(`/api/messages/${msg.id}/ack`).set(as(recipient));
    expect(first.body.status.state).toBe('open');
    const second = await h.api().post(`/api/messages/${msg.id}/ack`).set(as(third));
    expect(second.body.status.state).toBe('satisfied');
  });

  it('acknowledging twice counts once', async () => {
    const msg = await send(h, sender, room.id, 'Once', blocking());
    await Promise.all([1, 2, 3].map(() => h.api().post(`/api/messages/${msg.id}/ack`).set(as(recipient))));
    const res = await h.api().get(`/api/messages/${msg.id}/delivery`).set(as(sender));
    expect(res.body.status.ack.required.filter((r: { ackedAt: string }) => r.ackedAt)).toHaveLength(1);
    expect(res.body.status.ack.state).toBe('satisfied');
  });

  it('lists what is waiting on someone, soonest first, until they answer', async () => {
    const later = await send(h, sender, room.id, 'Later one', blocking(120));
    const sooner = await send(h, sender, room.id, 'Sooner one', blocking(30));
    const items = async (who: TestUser) => (await h.api().get('/api/notifications/needs-you').set(as(who))).body.items;

    expect((await items(recipient)).map((i: { messageId: string }) => i.messageId)).toEqual([sooner.id, later.id]);
    expect((await items(recipient))[0]).toMatchObject({ roomName: 'Ops', senderName: 'Sender', excerpt: 'Sooner one' });
    expect(await items(sender)).toEqual([]);

    await h.api().post(`/api/messages/${sooner.id}/ack`).set(as(recipient));
    expect((await items(recipient)).map((i: { messageId: string }) => i.messageId)).toEqual([later.id]);
  });

  it('only the people asked can acknowledge', async () => {
    const msg = await send(h, sender, room.id, 'x', blocking());
    expect((await h.api().post(`/api/messages/${msg.id}/ack`).set(as(sender))).status).toBe(403);
    const outsider = await makeUser(h);
    expect((await h.api().post(`/api/messages/${msg.id}/ack`).set(as(outsider))).status).toBe(404);
  });

  it('refuses to acknowledge an ordinary message', async () => {
    const msg = await send(h, sender, room.id, 'normal');
    expect((await h.api().post(`/api/messages/${msg.id}/ack`).set(as(recipient))).status).toBe(409);
  });

  it('reminds those outstanding before the deadline, once', async () => {
    const { AckContract, Notification, sweep } = await models();
    const msg = await send(h, sender, room.id, 'Reminder', blocking());
    await sweep();

    const contract = await AckContract.findOne({ messageId: msg.id }).lean();
    await sweep(new Date(contract!.reminderAt.getTime() + 1000));
    await sweep(new Date(contract!.reminderAt.getTime() + 2000));
    const reminders = await Notification.find({ messageId: msg.id, kind: 'ack_reminder' }).lean();
    expect(reminders).toHaveLength(1);
    expect(String(reminders[0]!.userId)).toBe(recipient.id);
  });

  it('skips the reminder for someone who already acknowledged', async () => {
    const { AckContract, Notification, sweep } = await models();
    const msg = await send(h, sender, room.id, 'Done', blocking());
    await h.api().post(`/api/messages/${msg.id}/ack`).set(as(recipient));
    const contract = await AckContract.findOne({ messageId: msg.id }).lean();
    await sweep(new Date(contract!.reminderAt.getTime() + 1000));
    expect(await Notification.countDocuments({ messageId: msg.id, kind: 'ack_reminder' })).toBe(0);
  });

  it('on expiry, tells the sender who never responded and updates the message', async () => {
    const { Notification, sweep } = await models();
    const msg = await send(h, sender, room.id, 'Expiring', blocking());
    const socket = await socketFor(h, recipient.token);
    const updated = nextEvent<{ status: { state: string } }>(socket, 'ack:updated');
    await sweep(new Date(Date.now() + 2 * 3_600_000));

    expect((await updated).status.state).toBe('expired');
    const notice = await Notification.findOne({ messageId: msg.id, kind: 'ack_expired' }).lean();
    expect(String(notice!.userId)).toBe(sender.id);
    expect(notice!.body).toContain('Recipient');

    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(sender));
    expect(page.body.messages[0].ack.state).toBe('expired');
  });

  it('records a late acknowledgement without un-expiring the contract', async () => {
    const { sweep } = await models();
    const msg = await send(h, sender, room.id, 'Late', blocking());
    await sweep(new Date(Date.now() + 2 * 3_600_000));
    const res = await h.api().post(`/api/messages/${msg.id}/ack`).set(as(recipient));
    expect(res.status).toBe(200);
    expect(res.body.status.state).toBe('expired');
    expect(res.body.status.required[0].ackedAt).toBeTruthy();
  });

  it('keeps showing as unread-able truth to the sender only', async () => {
    const msg = await send(h, sender, room.id, 'Private status', blocking());
    expect((await h.api().get(`/api/messages/${msg.id}/delivery`).set(as(recipient))).status).toBe(403);
  });
});

describe('failure handling', () => {
  it('retries transient push failures with backoff, then succeeds', async () => {
    const { Notification, setPushSender, sweep } = await models();
    const push = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error('push service down')).mockResolvedValue(undefined);
    setPushSender(push);
    const msg = await send(h, sender, room.id, 'retry me');

    await sweep();
    let row = await Notification.findOne({ messageId: msg.id }).lean();
    expect(row).toMatchObject({ state: 'pending', attempts: 1, reason: 'push service down' });
    expect(row!.dueAt.getTime()).toBeGreaterThan(Date.now());

    await sweep(new Date(row!.dueAt.getTime() + 1000));
    row = await Notification.findOne({ messageId: msg.id }).lean();
    expect(row!.state).toBe('sent');
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('gives up after repeated failure, visibly', async () => {
    const { Notification, setPushSender, sweep } = await models();
    setPushSender(async () => {
      throw new Error('gone');
    });
    const msg = await send(h, sender, room.id, 'doomed');
    let at = new Date();
    for (let i = 0; i < 6; i += 1) {
      await sweep(at);
      at = new Date(at.getTime() + 3_600_000);
    }
    expect(await Notification.findOne({ messageId: msg.id }).lean()).toMatchObject({ state: 'failed', reason: 'gone' });
    const status = await h.api().get(`/api/messages/${msg.id}/delivery`).set(as(sender));
    expect(status.body.status.recipients[0].state).toBe('failed');
    // The message itself is unaffected by a notification failing.
    const page = await h.api().get(`/api/rooms/${room.id}/messages`).set(as(recipient));
    expect(page.body.messages).toHaveLength(1);
  });

  it('a crashed worker\'s lease expires and the work is picked up', async () => {
    const { Notification, setPushSender, sweep } = await models();
    const push = vi.fn(async () => {});
    setPushSender(push);
    const msg = await send(h, sender, room.id, 'orphan');
    await Notification.updateOne({ messageId: msg.id }, { leaseUntil: inMinutes(1), attempts: 1 });

    await sweep();
    expect(push).not.toHaveBeenCalled();
    await sweep(inMinutes(2));
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('concurrent sweeps deliver exactly once', async () => {
    const { setPushSender, sweep } = await models();
    const push = vi.fn(async () => {
      await sleep(20);
    });
    setPushSender(push);
    await Promise.all(Array.from({ length: 5 }, (_, i) => send(h, sender, room.id, `m${i}`)));
    await Promise.all([sweep(), sweep(), sweep(), sweep()]);
    expect(push).toHaveBeenCalledTimes(5);
  });

  it('a retried send cannot create a second notification', async () => {
    const { Notification } = await models();
    const body = { clientMessageId: randomUUID(), content: { type: 'text', text: 'dup' } };
    const [a] = await Promise.all([
      h.api().post(`/api/rooms/${room.id}/messages`).set(as(sender)).send(body),
      h.api().post(`/api/rooms/${room.id}/messages`).set(as(sender)).send(body),
    ]);
    expect(await Notification.countDocuments({ messageId: a.body.message.id })).toBe(1);
  });

  it('push payloads carry no message content', async () => {
    const { setPushSender, sweep } = await models();
    const push = vi.fn(async (_userId: string, _payload: { title: string; url: string }) => {});
    setPushSender(push);
    await send(h, sender, room.id, 'very private text');
    await sweep();
    expect(JSON.stringify(push.mock.calls[0])).not.toContain('very private');
  });

  it('skips push for someone already online', async () => {
    const { setPushSender, sweep } = await models();
    const push = vi.fn(async () => {});
    setPushSender(push);
    await socketFor(h, recipient.token);
    await send(h, sender, room.id, 'you are here');
    await sweep();
    expect(push).not.toHaveBeenCalled();
  });
});

describe('background jobs', () => {
  it('BullMQ drives the sweep through real Redis', async () => {
    const { Notification, setPushSender } = await models();
    process.env.DELIVERY_SWEEP_SECONDS = '1';
    const { resetEnv } = await import('../src/config/env.js');
    resetEnv();
    const push = vi.fn(async () => {});
    setPushSender(push);
    const { startJobs } = await import('../src/jobs/index.js');
    const jobs = await startJobs('all');
    try {
      const msg = await send(h, sender, room.id, 'via bullmq', {});
      await vi.waitFor(
        async () => {
          expect(await Notification.findOne({ messageId: msg.id }).lean()).toMatchObject({ state: 'sent' });
        },
        { timeout: 6000, interval: 100 },
      );
      expect(push).toHaveBeenCalled();
    } finally {
      await jobs.stop();
      const { setSweepKick } = await models();
      setSweepKick(() => {});
    }
  });
});
