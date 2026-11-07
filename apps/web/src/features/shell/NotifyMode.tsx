import { useEffect, useState } from 'react';
import type { NotificationPreferences } from '@strata/shared';
import { api } from '../../api/client';
import { Segmented, Spinner } from '../../components/ui';
import { toastError } from '../../state/store';

type Mode = 'default' | 'digest' | 'mute';

/** A conversation-wide rule is the one that names this room and nothing narrower. */
const isRoomRule = (roomId: string) => (r: NotificationPreferences['rules'][number]) => r.roomId === roomId && !r.posture && !r.senderId;

/**
 * Digest only used to exist as a sender's choice and a hand-built rule in Settings. This is the same rule, put where
 * people decide how much a conversation may interrupt them.
 */
export function NotifyMode({ roomId }: { roomId: string }) {
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);

  useEffect(() => {
    api<{ preferences: NotificationPreferences }>('/notifications/preferences')
      .then((r) => setPrefs(r.preferences))
      .catch(toastError);
  }, []);

  if (!prefs) return <Spinner />;
  const current = prefs.rules.find(isRoomRule(roomId));
  const mode: Mode = !current ? 'default' : current.action === 'digest' ? 'digest' : current.action === 'mute' ? 'mute' : 'default';

  const choose = async (next: Mode) => {
    const rules = prefs.rules.filter((r) => !isRoomRule(roomId)(r));
    if (next !== 'default') rules.push({ id: crypto.randomUUID().slice(0, 12), roomId, action: next });
    const before = prefs;
    setPrefs({ ...prefs, rules });
    try {
      const { preferences } = await api<{ preferences: NotificationPreferences }>('/notifications/preferences', { method: 'PUT', body: { ...prefs, rules } });
      setPrefs(preferences);
    } catch (err) {
      setPrefs(before);
      toastError(err);
    }
  };

  return (
    <div className="mb-2">
      <Segmented
        label="Notify me"
        value={mode}
        onChange={(m) => void choose(m)}
        options={[
          ['default', 'Normal'],
          ['digest', 'Digest only'],
          ['mute', 'Silent'],
        ]}
      />
      <p className="mt-1.5 text-xs text-ink-2">
        {mode === 'digest'
          ? 'Messages wait for your next digest, then arrive as one notification.'
          : mode === 'mute'
            ? 'No notifications at all. Messages still appear here, and the unread count still grows.'
            : 'Notified as each sender intended.'}{' '}
        This applies to acknowledgement requests too.
      </p>
    </div>
  );
}
