import { ArrowLeft, Laptop, LogOut, Moon, Plus, Sun, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { DeviceSessionDTO, NotificationPreferences, NotificationRule, SelfDTO } from '@strata/shared';
import { api } from '../../api/client';
import { Button, Field, IconButton, Input, Pill, Spinner, Textarea, cx, shortTime } from '../../components/ui';
import { logout } from '../../state/actions';
import { toast, toastError, useStore } from '../../state/store';

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t border-line py-6 first:border-t-0">
      <h2 className="font-serif text-xl font-medium">{title}</h2>
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
        Save
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
            <Pill tone="vein">This device</Pill>
          ) : (
            <Button className="h-8 hover:border-oxide hover:text-oxide" onClick={() => revoke(s.id)}>
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
        <select value={prefs.timezone} onChange={(e) => update({ timezone: e.target.value })} className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[15px] outline-none focus:border-vein">
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
          <input type="checkbox" className="size-4 accent-[var(--vein)]" checked={prefs.quietHours.enabled} onChange={(e) => update({ quietHours: { ...prefs.quietHours, enabled: e.target.checked } })} />
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
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--vein)]" checked={prefs.blockingBypassesQuiet} onChange={(e) => update({ blockingBypassesQuiet: e.target.checked })} />
          <span>
            Let acknowledgement requests through during quiet hours
            <span className="block text-xs text-ink-2">Turn this off and they wait until your quiet hours end.</span>
          </span>
        </label>
      </div>

      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-[var(--vein)]" checked={prefs.channels.inApp} onChange={(e) => update({ channels: { ...prefs.channels, inApp: e.target.checked } })} />
          In the app
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="size-4 accent-[var(--vein)]" checked={prefs.channels.push} onChange={(e) => update({ channels: { ...prefs.channels, push: e.target.checked } })} />
          Push notifications
        </label>
      </div>

      <div>
        <p className="mb-1 text-[13px] font-medium text-ink-2">Rules</p>
        <p className="mb-2 text-xs text-ink-2">Your rules always win over how a sender chose to reach you. The first match applies.</p>
        <ul className="mb-2 space-y-1">
          {prefs.rules.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-lg bg-sunken px-2.5 py-1.5 text-sm">
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
  const [theme, setTheme] = useState(() => localStorage.getItem('strata:theme') ?? 'system');
  const choose = (value: string) => {
    setTheme(value);
    localStorage.setItem('strata:theme', value);
    if (value === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = value;
  };
  return (
    <div className="flex gap-1.5">
      {[
        ['system', 'System', <Laptop key="s" size={15} />],
        ['light', 'Light', <Sun key="l" size={15} />],
        ['dark', 'Dark', <Moon key="d" size={15} />],
      ].map(([value, label, icon]) => (
        <button key={value as string} type="button" aria-pressed={theme === value} onClick={() => choose(value as string)} className={cx('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition', theme === value ? 'border-vein bg-vein-soft' : 'border-line hover:border-line-strong')}>
          {icon} {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const navigate = useNavigate();
  return (
    <div className="scroll-thin h-full overflow-y-auto bg-paper">
      <div className="mx-auto max-w-2xl px-5 py-4">
        <header className="mb-2 flex items-center gap-2">
          <IconButton label="Back" onClick={() => navigate('/')} className="lg:hidden">
            <ArrowLeft size={18} />
          </IconButton>
          <h1 className="font-serif text-2xl font-medium">Settings</h1>
        </header>
        <Section title="Profile">
          <Profile />
        </Section>
        <Section title="Attention" hint="How and when other people's messages may interrupt you.">
          <Attention />
          {'PushManager' in window && (
            <Button className="mt-3" onClick={enablePush}>
              Enable push on this device
            </Button>
          )}
        </Section>
        <Section title="Devices" hint="Everywhere you're signed in.">
          <Devices />
        </Section>
        <Section title="Appearance">
          <Theme />
        </Section>
        <Section title="Privacy">
          <p className="text-sm text-ink-2">Strata is not end-to-end encrypted. Messages are protected in transit and stored on the server, which can read them to power search and notifications.</p>
        </Section>
        <div className="border-t border-line py-6">
          <Button onClick={() => void logout()}>
            <LogOut size={15} /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
