import { DateTime } from 'luxon';
import type { NotificationPreferences, NotificationRule, Posture } from '@strata/shared';

/**
 * The delivery policy, as pure functions of time and preferences.
 *
 * Nothing here affects whether a message exists. By this point the message is already persisted and visible in the
 * conversation. This only decides whether, and when, the recipient gets interrupted about it.
 */
export type Decision =
  | { action: 'none' }
  | { action: 'suppress'; reason: string }
  | { action: 'schedule'; dueAt: Date; digest: boolean; reason: string | null };

export interface DecisionInput {
  posture: Posture;
  prefs: NotificationPreferences;
  now: Date;
  muted: boolean;
  roomId: string;
  senderId: string;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const local = (at: Date, prefs: NotificationPreferences) => DateTime.fromJSDate(at, { zone: prefs.timezone });

const atTime = (day: DateTime, hhmm: string) => {
  const [hour, minute] = hhmm.split(':').map(Number);
  return day.set({ hour: hour ?? 0, minute: minute ?? 0, second: 0, millisecond: 0 });
};

export function isQuiet(prefs: NotificationPreferences, at: Date): boolean {
  const { enabled, start, end } = prefs.quietHours;
  if (!enabled || start === end) return false;
  const t = local(at, prefs);
  const now = t.hour * 60 + t.minute;
  const [s, e] = [minutes(start), minutes(end)];
  return s < e ? now >= s && now < e : now >= s || now < e;
}

export function quietEnd(prefs: NotificationPreferences, at: Date): Date {
  const t = local(at, prefs);
  const today = atTime(t, prefs.quietHours.end);
  return (today > t ? today : atTime(t.plus({ days: 1 }), prefs.quietHours.end)).toJSDate();
}

/** The next digest window after `at`, in the recipient's own timezone. Quiet hours can push it later. */
export function nextDigestAt(prefs: NotificationPreferences, at: Date): Date {
  const t = local(at, prefs);
  const candidates = [0, 1, 2]
    .flatMap((offset) => prefs.digestWindows.map((w) => atTime(t.plus({ days: offset }), w)))
    .filter((c) => c > t)
    .sort((a, b) => a.toMillis() - b.toMillis());
  const next = (candidates[0] ?? t.plus({ days: 1 })).toJSDate();
  return isQuiet(prefs, next) ? quietEnd(prefs, next) : next;
}

export function matchRule(rules: NotificationRule[], input: Pick<DecisionInput, 'posture' | 'roomId' | 'senderId'>) {
  return rules.find(
    (r) =>
      (!r.roomId || r.roomId === input.roomId) &&
      (!r.senderId || r.senderId === input.senderId) &&
      (!r.posture || r.posture === input.posture),
  );
}

export function decide(input: DecisionInput): Decision {
  const { posture, prefs, now, muted } = input;

  if (posture === 'whisper') return { action: 'none' };

  // The recipient has the last word. A sender's chosen posture never overrides a mute.
  const rule = matchRule(prefs.rules, input);
  if (muted) return { action: 'suppress', reason: 'room_muted' };
  if (rule?.action === 'mute') return { action: 'suppress', reason: 'rule_muted' };

  let effective = posture;
  if (rule?.action === 'digest') effective = 'digest';
  if (rule?.action === 'deliver' && posture === 'digest') effective = 'standard';

  if (effective === 'digest') {
    return { action: 'schedule', dueAt: nextDigestAt(prefs, now), digest: true, reason: 'digest_window' };
  }
  if (isQuiet(prefs, now) && !(effective === 'blocking_ack' && prefs.blockingBypassesQuiet)) {
    return { action: 'schedule', dueAt: quietEnd(prefs, now), digest: false, reason: 'quiet_hours' };
  }
  return { action: 'schedule', dueAt: now, digest: false, reason: null };
}

const MAX_BACKOFF_MS = 30 * 60_000;

/** When to try again after a failed attempt. */
export const retryDelayMs = (attempts: number): number => Math.min(30_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);

export const MAX_ATTEMPTS = 5;
