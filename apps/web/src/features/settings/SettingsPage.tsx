import { Laptop, LogOut, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { DeviceSessionDTO, NotificationPreferences, NotificationRule, SelfDTO } from '@strata/shared';
import { api } from '../../api/client';
import { Button, Field, IconButton, Input, Pill, Segmented, Spinner, Textarea, shortTime } from '../../components/ui';
import { logout } from '../../state/actions';
import { toast, toastError, useStore } from '../../state/store';

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 border-t border-line py-6 first:border-t-0">
      <h2 className="text-lg font-bold">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-ink-2">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Profile() {
  const me = useStore((s) => s.me)!;
  const [displayName, setName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio);
  const save = async () => {
    try {
      const { user } = await api<{ user: SelfDTO }>('/users/me', { method: 'PATCH', body: { displayName, bio } });
      useStore.setState({ me: user });
      toast('Profile saved');
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div className="space-y-3">
      <Field label="Name">
        <Input value={displayName} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="About you">
        <Textarea rows={2} value={bio} maxLength={280} onChange={(e) => setBio(e.target.value)} />
      </Field>
      <p className="text-sm text-ink-2">
        @{me.handle} · {me.email}
      </p>
      <Button variant="primary" onClick={save}>
        Save profile
      </Button>
    </div>
  );
}

function Devices() {
  const [sessions, setSessions] = useState<DeviceSessionDTO[] | null>(null);
  const load = () =>
    api<{ sessions: DeviceSessionDTO[] }>('/auth/sessions')
      .then((r) => setSessions(r.sessions))
      .catch(toastError);
  useEffect(() => {
    void load();
  }, []);
  const revoke = async (id: string) => {
    await api(`/auth/sessions/${id}`, { method: 'DELETE' }).catch(toastError);
    await load();
  };
  if (!sessions) return <Spinner />;
  return (
    <ul className="divide-y divide-line">
      {sessions.map((s) => (
        <li key={s.id} className="flex items-center gap-3 py-2.5">
          <Laptop size={18} className="shrink-0 text-ink-2" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{s.deviceName}</p>
            <p className="truncate text-xs text-ink-2">Active {shortTime(s.lastSeenAt)}</p>
          </div>
          {s.current ? (
            <Pill tone="branch">This device</Pill>
          ) : (
            <Button className="h-8 hover:border-alert hover:text-alert" onClick={() => revoke(s.id)}>
              Sign out
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

const ZONES: string[] = (() => {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
  return all ?? [Intl.DateTimeFormat().resolvedOptions().timeZone];
})();

const RULE_LABEL = { deliver: 'Notify me now', digest: 'Save for my digest', mute: 'Never notify me' };
const POSTURE_LABEL: Record<string, string> = { standard: 'standard messages', digest: 'digest messages', blocking_ack: 'acknowledgement requests' };

function Attention() {
  const rooms = useStore((s) => s.rooms);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [rule, setRule] = useState<Partial<NotificationRule>>({ action: 'digest' });

  useEffect(() => {
    api<{ preferences: NotificationPreferences }>('/notifications/preferences')
      .then((r) => setPrefs(r.preferences))
      .catch(toastError);
  }, []);

  if (!prefs) return <Spinner />;

  const update = (patch: Partial<NotificationPreferences>) => setPrefs({ ...prefs, ...patch });
  const save = async () => {
    try {
      await api('/notifications/preferences', { method: 'PUT', body: prefs });
      toast('Saved');
    } catch (err) {
      toastError(err);
    }
  };
  const roomName = (id?: string) => (id ? (rooms[id]?.name ?? 'a conversation') : 'all conversations');

  return (
    <div className="space-y-4">
      <Field label="Your timezone" hint="Digests and quiet hours follow this clock.">
        <select value={prefs.timezone} onChange={(e) => update({ timezone: e.target.value })} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[15px] outline-none focus:border-violet">
          {[...new Set([prefs.timezone, ...ZONES])].map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
      </Field>

      <div>
        <p className="mb-1 text-[13px] font-medium text-ink-2">Digest windows</p>
        <div className="flex flex-wrap items-center gap-2">
          {prefs.digestWindows.map((w, i) => (
            <span key={i} className="flex items-center gap-1">
              <Input type="time" aria-label={`Digest window ${i + 1}`} value={w} className="w-32 py-1" onChange={(e) => update({ digestWindows: prefs.digestWindows.map((x, j) => (j === i ? e.target.value : x)) })} />
              {prefs.digestWindows.length > 1 && (
                <IconButton label="Remove window" className="size-7" onClick={() => update({ digestWindows: prefs.digestWindows.filter((_, j) => j !== i) })}>
                  <Trash2 size={14} />
                </IconButton>
              )}
            </span>
          ))}
          {prefs.digestWindows.length < 6 && (
            <IconButton label="Add window" className="size-8" onClick={() => update({ digestWindows: [...prefs.digestWindows, '12:00'] })}>
              <Plus size={16} />
            </IconButton>
          )}
        </div>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--violet-fill)]" checked={prefs.quietHours.enabled} onChange={(e) => update({ quietHours: { ...prefs.quietHours, enabled: e.target.checked } })} />
          Quiet hours
        </label>
        {prefs.quietHours.enabled && (
          <div className="mt-2 flex items-center gap-2 text-sm">
            <Input type="time" aria-label="Quiet hours start" className="w-32 py-1" value={prefs.quietHours.start} onChange={(e) => update({ quietHours: { ...prefs.quietHours, start: e.target.value } })} />
            to
            <Input type="time" aria-label="Quiet hours end" className="w-32 py-1" value={prefs.quietHours.end} onChange={(e) => update({ quietHours: { ...prefs.quietHours, end: e.target.value } })} />
          </div>
        )}
        <label className="mt-2 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--violet-fill)]" checked={prefs.blockingBypassesQuiet} onChange={(e) => update({ blockingBypassesQuiet: e.target.checked })} />
          <span>
            Let acknowledgement requests through during quiet hours
            <span className="block text-xs text-ink-2">Turn this off and they wait until your quiet hours end.</span>
          </span>
        </label>
      </div>

      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-[var(--violet-fill)]" checked={prefs.channels.inApp} onChange={(e) => update({ channels: { ...prefs.channels, inApp: e.target.checked } })} />
          In the app
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-[var(--violet-fill)]" checked={prefs.channels.push} onChange={(e) => update({ channels: { ...prefs.channels, push: e.target.checked } })} />
          Push notifications
        </label>
      </div>

      <div>
        <p className="mb-1 text-[13px] font-medium text-ink-2">Rules</p>
        <p className="mb-2 text-xs text-ink-2">Your rules always win over how a sender chose to reach you. The first match applies.</p>
        <ul className="mb-2 space-y-1">
          {prefs.rules.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-lg bg-tint-plain px-2.5 py-1.5 text-sm">
              <span className="min-w-0 flex-1">
                {RULE_LABEL[r.action]} for {r.posture ? POSTURE_LABEL[r.posture] : 'everything'} in {roomName(r.roomId)}
              </span>
              <IconButton label="Remove rule" className="size-7" onClick={() => update({ rules: prefs.rules.filter((x) => x.id !== r.id) })}>
                <Trash2 size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Rule action" value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value as NotificationRule['action'] })} className="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm">
            {Object.entries(RULE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select aria-label="Rule conversation" value={rule.roomId ?? ''} onChange={(e) => setRule({ ...rule, roomId: e.target.value || undefined })} className="min-w-0 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm">
            <option value="">All conversations</option>
            {Object.values(rooms)
              .filter((r) => r.me.role)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
          <Button
            className="h-8"
            onClick={() => {
              update({ rules: [...prefs.rules, { id: crypto.randomUUID().slice(0, 12), action: rule.action!, roomId: rule.roomId }] });
              setRule({ action: 'digest' });
            }}
          >
            <Plus size={14} /> Add rule
          </Button>
        </div>
      </div>

      <Button variant="primary" onClick={save}>
        Save preferences
      </Button>
    </div>
  );
}

async function enablePush() {
  try {
    const { publicKey } = await api<{ publicKey: string | null }>('/notifications/push-key');
    if (!publicKey) return toast('Push is not configured on this server yet', 'error');
    if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications are blocked in your browser', 'error');
    const registration = await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/notifications/push-subscriptions', { method: 'POST', body: sub.toJSON() });
    toast('Push notifications are on');
  } catch (err) {
    toastError(err);
  }
}

function Theme() {
  const [theme, setTheme] = useState(() => (localStorage.getItem('strata:theme') === 'day' ? 'day' : 'deep'));
  const choose = (value: string) => {
    setTheme(value);
    localStorage.setItem('strata:theme', value);
    if (value === 'day') document.documentElement.dataset.theme = 'day';
    else document.documentElement.removeAttribute('data-theme');
  };
  return <Segmented label="Theme" value={theme} onChange={choose} options={[['deep', 'Deep'], ['day', 'Day']]} />;
}

const SECTIONS = [
  ['profile', 'Profile'],
  ['attention', 'Attention'],
  ['devices', 'Devices'],
  ['appearance', 'Appearance'],
  ['privacy', 'Privacy'],
];

export function SettingsPage() {
  return (
    <div className="flex h-full">
      <nav aria-label="Settings sections" className="hidden w-80 shrink-0 flex-col gap-1 border-r border-line bg-basin p-4 lg:flex">
        <h1 className="mb-3 text-2xl font-bold tracking-tight">You</h1>
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="st-press rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-2 hover:bg-tint-plain hover:text-ink">
            {label}
          </a>
        ))}
      </nav>
      <div className="scroll-thin min-w-0 flex-1 overflow-y-auto pb-28 lg:pb-6">
        <div className="mx-auto max-w-2xl px-5 py-4">
          <h1 className="mb-2 text-2xl font-bold tracking-tight lg:hidden">You</h1>
          <Section id="profile" title="Profile">
            <Profile />
          </Section>
          <Section id="attention" title="Attention" hint="How and when other people's messages may interrupt you.">
            <Attention />
            {'PushManager' in window && (
              <Button className="mt-3" onClick={enablePush}>
                Enable push on this device
              </Button>
            )}
          </Section>
          <Section id="devices" title="Devices" hint="Everywhere you're signed in.">
            <Devices />
          </Section>
          <Section id="appearance" title="Appearance">
            <Theme />
          </Section>
          <Section id="privacy" title="Privacy">
            <p className="text-sm text-ink-2">Strata is not end-to-end encrypted. Messages are protected in transit and stored on the server, which can read them to power search and notifications.</p>
          </Section>
          <div className="border-t border-line py-6">
            <Button onClick={() => void logout()}>
              <LogOut size={15} /> Sign out
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
