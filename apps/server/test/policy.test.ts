import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type NotificationPreferences, type Posture } from '@strata/shared';
import { decide, isQuiet, matchRule, nextDigestAt, quietEnd, retryDelayMs } from '../src/modules/delivery/policy.js';

const prefs = (over: Partial<NotificationPreferences> = {}): NotificationPreferences => ({ ...DEFAULT_PREFERENCES, ...over });
const quiet = { enabled: true, start: '22:00', end: '07:00' };

const ask = (posture: Posture, p: NotificationPreferences, now: string, muted = false) =>
  decide({ posture, prefs: p, now: new Date(now), muted, roomId: 'r1', senderId: 's1' });

describe('postures', () => {
  it('whisper never schedules anything, whatever the rules say', () => {
    expect(ask('whisper', prefs(), '2026-06-01T12:00:00Z')).toEqual({ action: 'none' });
    expect(ask('whisper', prefs({ rules: [{ id: '1', action: 'deliver' }] }), '2026-06-01T12:00:00Z')).toEqual({ action: 'none' });
  });

  it('standard delivers now', () => {
    const d = ask('standard', prefs(), '2026-06-01T12:00:00Z');
    expect(d).toMatchObject({ action: 'schedule', digest: false, reason: null });
    expect(d.action === 'schedule' && d.dueAt.toISOString()).toBe('2026-06-01T12:00:00.000Z');
  });

  it('digest waits for the next window', () => {
    const d = ask('digest', prefs(), '2026-06-01T12:00:00Z');
    expect(d).toMatchObject({ action: 'schedule', digest: true });
    expect(d.action === 'schedule' && d.dueAt.toISOString()).toBe('2026-06-01T17:30:00.000Z');
  });

  it('standard waits out quiet hours', () => {
    const d = ask('standard', prefs({ quietHours: quiet }), '2026-06-01T23:00:00Z');
    expect(d).toMatchObject({ reason: 'quiet_hours', digest: false });
    expect(d.action === 'schedule' && d.dueAt.toISOString()).toBe('2026-06-02T07:00:00.000Z');
  });

  it('blocking ack passes quiet hours only with the recipient\'s consent', () => {
    const now = '2026-06-01T23:00:00Z';
    expect(ask('blocking_ack', prefs({ quietHours: quiet, blockingBypassesQuiet: true }), now)).toMatchObject({ reason: null });
    expect(ask('blocking_ack', prefs({ quietHours: quiet, blockingBypassesQuiet: false }), now)).toMatchObject({ reason: 'quiet_hours' });
  });
});

describe('the recipient has the last word', () => {
  it('a muted room suppresses everything, blocking included', () => {
    for (const posture of ['digest', 'standard', 'blocking_ack'] as const) {
      expect(ask(posture, prefs(), '2026-06-01T12:00:00Z', true)).toEqual({ action: 'suppress', reason: 'room_muted' });
    }
  });

  it('a mute rule beats any posture', () => {
    const p = prefs({ rules: [{ id: '1', senderId: 's1', action: 'mute' }] });
    expect(ask('blocking_ack', p, '2026-06-01T12:00:00Z')).toEqual({ action: 'suppress', reason: 'rule_muted' });
  });

  it('a digest rule downgrades standard', () => {
    const p = prefs({ rules: [{ id: '1', roomId: 'r1', action: 'digest' }] });
    expect(ask('standard', p, '2026-06-01T12:00:00Z')).toMatchObject({ digest: true });
  });

  it('a deliver rule can upgrade a digest', () => {
    const p = prefs({ rules: [{ id: '1', senderId: 's1', action: 'deliver' }] });
    expect(ask('digest', p, '2026-06-01T12:00:00Z')).toMatchObject({ digest: false });
  });

  it('first matching rule wins, and rules can target a posture', () => {
    const rules = [
      { id: '1', posture: 'blocking_ack' as const, action: 'deliver' as const },
      { id: '2', action: 'mute' as const },
    ];
    expect(matchRule(rules, { posture: 'blocking_ack', roomId: 'r', senderId: 's' })?.id).toBe('1');
    expect(matchRule(rules, { posture: 'standard', roomId: 'r', senderId: 's' })?.id).toBe('2');
    expect(matchRule([{ id: '1', roomId: 'other', action: 'mute' }], { posture: 'standard', roomId: 'r', senderId: 's' })).toBeUndefined();
  });
});

describe('quiet hours', () => {
  it('wraps past midnight', () => {
    const p = prefs({ quietHours: quiet });
    expect(isQuiet(p, new Date('2026-06-01T23:30:00Z'))).toBe(true);
    expect(isQuiet(p, new Date('2026-06-01T06:59:00Z'))).toBe(true);
    expect(isQuiet(p, new Date('2026-06-01T07:00:00Z'))).toBe(false);
    expect(isQuiet(p, new Date('2026-06-01T12:00:00Z'))).toBe(false);
  });

  it('works within a single day', () => {
    const p = prefs({ quietHours: { enabled: true, start: '13:00', end: '14:00' } });
    expect(isQuiet(p, new Date('2026-06-01T13:30:00Z'))).toBe(true);
    expect(isQuiet(p, new Date('2026-06-01T14:00:00Z'))).toBe(false);
  });

  it('is off when disabled, or when start equals end', () => {
    expect(isQuiet(prefs(), new Date('2026-06-01T23:30:00Z'))).toBe(false);
    expect(isQuiet(prefs({ quietHours: { enabled: true, start: '09:00', end: '09:00' } }), new Date('2026-06-01T09:00:00Z'))).toBe(false);
  });

  it('uses the recipient\'s clock, not the server\'s', () => {
    const tokyo = prefs({ timezone: 'Asia/Tokyo', quietHours: quiet });
    // 14:00 UTC is 23:00 in Tokyo.
    expect(isQuiet(tokyo, new Date('2026-06-01T14:00:00Z'))).toBe(true);
    expect(quietEnd(tokyo, new Date('2026-06-01T14:00:00Z')).toISOString()).toBe('2026-06-01T22:00:00.000Z');
  });
});

describe('digest scheduling', () => {
  it('rolls to tomorrow after the last window', () => {
    expect(nextDigestAt(prefs(), new Date('2026-06-01T18:00:00Z')).toISOString()).toBe('2026-06-02T09:00:00.000Z');
  });

  it('never returns the current instant', () => {
    expect(nextDigestAt(prefs(), new Date('2026-06-01T09:00:00Z')).toISOString()).toBe('2026-06-01T17:30:00.000Z');
  });

  it('follows the recipient\'s timezone', () => {
    const ny = prefs({ timezone: 'America/New_York', digestWindows: ['09:00'] });
    // June: New York is UTC-4.
    expect(nextDigestAt(ny, new Date('2026-06-01T12:00:00Z')).toISOString()).toBe('2026-06-01T13:00:00.000Z');
  });

  it('keeps wall-clock time across daylight saving changes', () => {
    const ny = prefs({ timezone: 'America/New_York', digestWindows: ['09:00'] });
    // Clocks go forward on 8 March 2026: 9am moves from 14:00 UTC to 13:00 UTC.
    expect(nextDigestAt(ny, new Date('2026-03-07T15:00:00Z')).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    // Clocks go back on 1 November 2026: 9am moves from 13:00 UTC to 14:00 UTC.
    expect(nextDigestAt(ny, new Date('2026-10-31T14:00:00Z')).toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  it('copes with a window inside the skipped hour', () => {
    const ny = prefs({ timezone: 'America/New_York', digestWindows: ['02:30'] });
    const at = nextDigestAt(ny, new Date('2026-03-08T05:00:00Z'));
    expect(at.getTime()).toBeGreaterThan(new Date('2026-03-08T05:00:00Z').getTime());
    expect(at.getTime()).toBeLessThan(new Date('2026-03-09T00:00:00Z').getTime());
  });

  it('moves a digest out of quiet hours', () => {
    const p = prefs({ digestWindows: ['23:00'], quietHours: quiet });
    expect(nextDigestAt(p, new Date('2026-06-01T12:00:00Z')).toISOString()).toBe('2026-06-02T07:00:00.000Z');
  });
});

describe('retry backoff', () => {
  it('grows and is capped', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(50)).toBe(30 * 60_000);
  });
});
