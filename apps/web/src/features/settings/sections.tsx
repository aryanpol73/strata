import { Camera, Download, Laptop, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Appearance, DeviceSessionDTO, NotificationPreferences, NotificationRule, SelfDTO } from '@strata/shared';
import { api } from '../../api/client';
import { Avatar, Button, Field, IconButton, Input, Pill, Segmented, Spinner, Textarea, shortTime } from '../../components/ui';
import { connectSocket, disconnectSocket } from '../../realtime/socket';
import { db } from '../../state/db';
import { toast, toastError, useStore } from '../../state/store';
import { securityCode } from '../e2ee/crypto';
import { changePassphrase, resetE2ee, useE2ee } from '../e2ee/service';
import { PhotoDialog } from './PhotoDialog';
import { disablePush, enablePush, pushState } from './push';
import { changeAppearance, useAppearance } from './appearance';
import { hasInstallPrompt, offerInstall } from './install';
import { Card, Choice, PageTitle, Row, SELECT, Toggle } from './parts';

declare const __APP_VERSION__: string;

const updateMe = async (patch: Partial<Pick<SelfDTO, 'displayName' | 'bio' | 'avatarPrivate' | 'showOnline'>>) => {
  const { user } = await api<{ user: SelfDTO }>('/users/me', { method: 'PATCH', body: patch });
  useStore.setState({ me: user });
};

export function ProfileSection() {
  const me = useStore((s) => s.me)!;
  const [displayName, setName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const save = async () => {
    setBusy(true);
    await updateMe({ displayName, bio })
      .then(() => toast('Profile saved'))
      .catch(toastError);
    setBusy(false);
  };
  const removePhoto = async () => {
    try {
      const { user } = await api<{ user: SelfDTO }>('/users/me/avatar', { method: 'DELETE' });
      useStore.setState({ me: user });
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <>
      <PageTitle title="Profile" hint="How you appear to people in your conversations." />
      <Card>
        <div className="flex items-center gap-4 py-3">
          <Avatar name={me.displayName} url={me.avatarUrl} size={72} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Profile photo</p>
            <p className="mb-2 text-[13px] text-ink-2">{me.avatarPrivate ? 'Private: only people you share a conversation with.' : 'Public: anyone on Strata.'}</p>
            <div className="flex flex-wrap gap-2">
              <Button className="h-9 px-3 text-[13px]" onClick={() => picker.current?.click()}>
                <Camera size={15} /> {me.avatarUrl ? 'Change photo' : 'Add photo'}
              </Button>
              {me.avatarUrl && (
                <Button variant="ghost" className="h-9 px-3 text-[13px]" onClick={removePhoto}>
                  Remove
                </Button>
              )}
            </div>
            <input
              ref={picker}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Choose a profile photo"
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </Card>
      <Card>
        <div className="space-y-3 py-3">
          <Field label="Name">
            <Input value={displayName} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="About you">
            <Textarea rows={3} value={bio} maxLength={280} onChange={(e) => setBio(e.target.value)} />
          </Field>
          <Button variant="primary" busy={busy} disabled={!displayName.trim()} onClick={save}>
            Save profile
          </Button>
        </div>
      </Card>
      {file && <PhotoDialog file={file} onClose={() => setFile(null)} />}
    </>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const mismatch = again.length > 0 && next !== again;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent('');
      setNext('');
      setAgain('');
      toast('Password changed. Your other devices were signed out.');
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={submit} className="space-y-3 py-3">
      <Field label="Current password">
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password" hint="At least 10 characters.">
        <Input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Repeat new password" hint={mismatch ? "These don't match yet." : undefined}>
        <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={!current || next.length < 10 || next !== again}>
        Change password
      </Button>
    </form>
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
  const revoke = async (ids: string[]) => {
    await Promise.all(ids.map((id) => api(`/auth/sessions/${id}`, { method: 'DELETE' }))).catch(toastError);
    await load();
  };
  if (!sessions) return <Spinner />;
  const others = sessions.filter((s) => !s.current).map((s) => s.id);
  return (
    <>
      <ul className="divide-y divide-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center gap-3 py-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-tint-plain text-ink-2">
              <Laptop size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{s.deviceName}</p>
              <p className="truncate text-[13px] text-ink-2">Active {shortTime(s.lastSeenAt)}</p>
            </div>
            {s.current ? (
              <Pill tone="branch">This device</Pill>
            ) : (
              <Button className="h-9 px-3 text-[13px]" onClick={() => revoke([s.id])}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others.length > 1 && (
        <div className="py-3">
          <Button variant="danger" onClick={() => revoke(others)}>
            Sign out all other devices
          </Button>
        </div>
      )}
    </>
  );
}

/** Both the first passphrase and a replacement need the same two fields, so they're one small form. */
function PassphraseForm({ action, label, onDone, fields = ['New encryption passphrase', 'Repeat new passphrase'] }: { action: (passphrase: string) => Promise<void>; label: string; onDone: () => void; fields?: [string, string] }) {
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await action(next);
      setNext('');
      setAgain('');
      onDone();
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };
  return (
    <form onSubmit={submit} className="space-y-3 py-3">
      <Field label={fields[0]} hint="At least 10 characters.">
        <Input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label={fields[1]} hint={again && next !== again ? "These don't match yet." : undefined}>
        <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={next.length < 10 || next !== again}>
        {label}
      </Button>
    </form>
  );
}

export function EncryptionSection() {
  const me = useStore((s) => s.me)!;
  const status = useE2ee((s) => s.status);
  const [code, setCode] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (me.e2ee) void securityCode(me.e2ee.publicKey).then(setCode);
  }, [me.e2ee]);

  return (
    <>
      <PageTitle title="Encryption" hint="Your messages are encrypted on this device, so only the people in a conversation can read them." />
      <Card title="On this device">
        <Row
          label="Status"
          hint={status === 'ready' ? 'Unlocked. Messages are encrypted before they leave this device.' : status === 'locked' ? 'Locked. Enter your passphrase to read your encrypted messages.' : status === 'needs-setup' ? 'Not set up yet.' : 'Checking…'}
        >
          {status === 'locked' && (
            <Button className="h-9 px-3 text-[13px]" onClick={() => useE2ee.setState({ unlockDismissed: false })}>
              Unlock
            </Button>
          )}
        </Row>
        {code && <Row label="Your security code" hint={<span className="font-mono tracking-wide">{code}</span>} />}
        <p className="py-3 text-[13px] text-ink-2">People can compare this with the code they see for you in a conversation's encryption details. If the two match, nobody has swapped your key.</p>
      </Card>

      {status === 'ready' && (
        <Card title="Passphrase" hint="It protects the backup of your key, which is how a new device unlocks your history. Changing it keeps the same keys.">
          <PassphraseForm label="Change passphrase" action={changePassphrase} onDone={() => toast('Passphrase changed')} />
        </Card>
      )}

      <Card title="What is and isn't encrypted">
        <Row label="Encrypted" hint="The text of messages in direct conversations, groups and branches, including edits." />
        <Row label="Not encrypted" hint="Who is in a conversation and when messages were sent, files and images, the Canvas, live blocks, branch titles and summaries, and guest branches." />
        <Row label="Searching" hint="The server can't read encrypted messages, so searching them only covers messages already opened on this device." />
      </Card>

      {me.e2ee && (
        <Card title="Start over" hint="If you've lost your passphrase, new keys let you carry on. Old messages stay locked until another member of each conversation shares its history with you again.">
          {resetting ? (
            <PassphraseForm label="Reset encryption keys" action={resetE2ee} onDone={() => setResetting(false)} fields={['Passphrase for your new keys', 'Repeat passphrase for your new keys']} />
          ) : (
            <div className="py-3">
              <Button variant="danger" onClick={() => setResetting(true)}>
                Reset encryption keys
              </Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

export function SecuritySection() {
  const me = useStore((s) => s.me)!;
  return (
    <>
      <PageTitle title="Account and security" hint="Your sign-in details and where you're signed in." />
      <Card title="Account">
        <Row label="Email" hint={me.email} />
        <Row label="Handle" hint={`@${me.handle}`} />
      </Card>
      <Card title="Password" hint="Changing it signs out your other devices.">
        <PasswordForm />
      </Card>
      <Card title="Devices" hint="Everywhere you're signed in.">
        <Devices />
      </Card>
    </>
  );
}

const SWATCHES: Record<Appearance['accent'], string[]> = {
  violet: ['#0b0914', '#241f3f', '#6a48f2', '#b5a2ff'],
  emerald: ['#07100d', '#182d25', '#0c7f5b', '#6ff0bd'],
};

export function AppearanceSection() {
  const a = useAppearance();
  const change = (patch: Partial<Appearance>) => void changeAppearance(patch).catch(toastError);
  return (
    <>
      <PageTitle title="Appearance" hint="These follow you to every device you sign in on." />
      <Card title="Colour theme">
        <div role="radiogroup" aria-label="Colour theme" className="grid grid-cols-2 gap-3 py-3">
          {(
            [
              ['violet', 'Violet'],
              ['emerald', 'Emerald'],
            ] as const
          ).map(([id, label]) => (
            <Choice key={id} label={label} selected={a.accent === id} onSelect={() => change({ accent: id })}>
              <span aria-hidden className="flex h-12 overflow-hidden rounded-xl">
                {SWATCHES[id].map((c) => (
                  <span key={c} className="flex-1" style={{ background: c }} />
                ))}
              </span>
            </Choice>
          ))}
        </div>
        <Row label="Mode" stack>
          <Segmented
            label="Mode"
            value={a.mode}
            onChange={(mode) => change({ mode })}
            options={[
              ['dark', 'Dark'],
              ['light', 'Light'],
              ['system', 'Match device'],
            ]}
          />
        </Row>
      </Card>
      <Card title="App icon" hint="Used for the browser tab, the logo in the app, and when you install Strata.">
        <div role="radiogroup" aria-label="App icon" className="grid grid-cols-2 gap-3 py-3">
          {(
            [
              ['violet', 'Violet'],
              ['emerald', 'Emerald'],
            ] as const
          ).map(([id, label]) => (
            <Choice key={id} label={label} selected={a.appIcon === id} onSelect={() => change({ appIcon: id })}>
              <img src={`/icons/${id}-192.png`} alt="" className="size-16" />
            </Choice>
          ))}
        </div>
        <p className="py-3 text-[13px] text-ink-2">If Strata is already on your home screen, remove it and install it again to see the new icon. Phones keep the icon from when the app was installed.</p>
      </Card>
      <Card title="Reading and motion">
        <Row label="Text size" stack>
          <Segmented
            label="Text size"
            value={a.textSize}
            onChange={(textSize) => change({ textSize })}
            options={[
              ['small', 'Small'],
              ['default', 'Default'],
              ['large', 'Large'],
            ]}
          />
        </Row>
        <Row label="Reduce motion" hint="Turns off button and screen animation. Your device's own setting always applies too.">
          <Toggle label="Reduce motion" checked={a.reduceMotion} onChange={(reduceMotion) => change({ reduceMotion })} />
        </Row>
      </Card>
    </>
  );
}

const ZONES: string[] = (() => {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
  return all ?? [Intl.DateTimeFormat().resolvedOptions().timeZone];
})();

const RULE_LABEL = { deliver: 'Notify me now', digest: 'Save for my digest', mute: 'Never notify me' };
const POSTURE_LABEL: Record<string, string> = { standard: 'standard messages', digest: 'digest messages', blocking_ack: 'acknowledgement requests' };

const PUSH_HINT = {
  unsupported: 'This browser can\'t receive push notifications. On an iPhone, add Strata to your home screen first.',
  blocked: 'Blocked in your browser. Allow notifications for this site in its settings, then come back.',
  off: 'Not turned on for this device yet.',
  on: 'On for this device.',
} as const;

function PushRow() {
  const [state, setState] = useState(pushState);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toastError(err);
    }
    setState(pushState());
    setBusy(false);
  };
  return (
    <Row label="This device" hint={PUSH_HINT[state]}>
      {state === 'off' && (
        <Button className="h-9 px-3 text-[13px]" busy={busy} onClick={() => run(async () => ((await enablePush()) === 'denied' ? toast('Notifications were not allowed', 'error') : toast('Push notifications are on')))}>
          Turn on
        </Button>
      )}
      {state === 'on' && (
        <Button className="h-9 px-3 text-[13px]" busy={busy} onClick={() => run(disablePush)}>
          Turn off
        </Button>
      )}
    </Row>
  );
}

function DigestHelp({ windows }: { windows: string[] }) {
  return (
    <p className="py-3 text-[13px] text-ink-2">
      A digest holds messages until {windows.join(' or ')} and then notifies you once, so a busy conversation can't keep interrupting you. Nothing is a digest
      unless the sender chose Digest, or you set a conversation to Digest only. Held messages are listed on the Attention screen, where you can also send the digest early.
    </p>
  );
}

export function NotificationsSection() {
  const rooms = useStore((s) => s.rooms);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [rule, setRule] = useState<Partial<NotificationRule>>({ action: 'digest' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ preferences: NotificationPreferences }>('/notifications/preferences')
      .then((r) => setPrefs(r.preferences))
      .catch(toastError);
  }, []);

  if (!prefs) return <Spinner />;

  const update = (patch: Partial<NotificationPreferences>) => setPrefs({ ...prefs, ...patch });
  const save = async () => {
    setBusy(true);
    await api('/notifications/preferences', { method: 'PUT', body: prefs })
      .then(() => toast('Saved'))
      .catch(toastError);
    setBusy(false);
  };
  const roomName = (id?: string) => (id ? (rooms[id]?.name ?? 'a conversation') : 'all conversations');

  return (
    <>
      <PageTitle title="Notifications" hint="How and when other people's messages may interrupt you." />
      <Card title="Where you're notified">
        <Row label="In the app">
          <Toggle label="In the app" checked={prefs.channels.inApp} onChange={(inApp) => update({ channels: { ...prefs.channels, inApp } })} />
        </Row>
        <Row label="Push notifications">
          <Toggle label="Push notifications" checked={prefs.channels.push} onChange={(push) => update({ channels: { ...prefs.channels, push } })} />
        </Row>
        <PushRow />
      </Card>

      <Card title="Timing">
        <Row label="Your timezone" hint="Digests and quiet hours follow this clock." stack>
          <select aria-label="Your timezone" value={prefs.timezone} onChange={(e) => update({ timezone: e.target.value })} className={SELECT}>
            {[...new Set([prefs.timezone, ...ZONES])].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Row>
        <Row label="Digest windows" hint="Held messages arrive together at these times." stack>
          <div className="flex flex-wrap items-center gap-2">
            {prefs.digestWindows.map((w, i) => (
              <span key={i} className="flex items-center gap-1">
                <Input type="time" aria-label={`Digest window ${i + 1}`} value={w} className="w-32 py-1.5" onChange={(e) => update({ digestWindows: prefs.digestWindows.map((x, j) => (j === i ? e.target.value : x)) })} />
                {prefs.digestWindows.length > 1 && (
                  <IconButton label="Remove window" onClick={() => update({ digestWindows: prefs.digestWindows.filter((_, j) => j !== i) })}>
                    <Trash2 size={15} />
                  </IconButton>
                )}
              </span>
            ))}
            {prefs.digestWindows.length < 6 && (
              <IconButton label="Add window" onClick={() => update({ digestWindows: [...prefs.digestWindows, '12:00'] })}>
                <Plus size={16} />
              </IconButton>
            )}
          </div>
        </Row>
      </Card>

      <Card title="How digests work">
        <DigestHelp windows={prefs.digestWindows} />
      </Card>

      <Card title="Quiet hours">
        <Row label="Quiet hours" hint="Hold notifications during these hours.">
          <Toggle label="Quiet hours" checked={prefs.quietHours.enabled} onChange={(enabled) => update({ quietHours: { ...prefs.quietHours, enabled } })} />
        </Row>
        {prefs.quietHours.enabled && (
          <div className="flex items-center gap-2 py-3 text-sm">
            <Input type="time" aria-label="Quiet hours start" className="w-32 py-1.5" value={prefs.quietHours.start} onChange={(e) => update({ quietHours: { ...prefs.quietHours, start: e.target.value } })} />
            to
            <Input type="time" aria-label="Quiet hours end" className="w-32 py-1.5" value={prefs.quietHours.end} onChange={(e) => update({ quietHours: { ...prefs.quietHours, end: e.target.value } })} />
          </div>
        )}
        <Row label="Let acknowledgement requests through" hint="Turn this off and they wait until your quiet hours end.">
          <Toggle label="Let acknowledgement requests through" checked={prefs.blockingBypassesQuiet} onChange={(blockingBypassesQuiet) => update({ blockingBypassesQuiet })} />
        </Row>
      </Card>

      <Card title="Rules" hint="Your rules always win over how a sender chose to reach you. The first match applies.">
        {prefs.rules.length > 0 && (
          <ul className="space-y-1 py-3">
            {prefs.rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-xl bg-tint-plain py-1 pr-1 pl-3 text-sm">
                <span className="min-w-0 flex-1">
                  {RULE_LABEL[r.action]} for {r.posture ? POSTURE_LABEL[r.posture] : 'everything'} in {roomName(r.roomId)}
                </span>
                <IconButton label="Remove rule" onClick={() => update({ rules: prefs.rules.filter((x) => x.id !== r.id) })}>
                  <Trash2 size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 py-3 sm:grid-cols-[1fr_1fr_auto]">
          <select aria-label="Rule action" value={rule.action} onChange={(e) => setRule({ ...rule, action: e.target.value as NotificationRule['action'] })} className={SELECT}>
            {Object.entries(RULE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select aria-label="Rule conversation" value={rule.roomId ?? ''} onChange={(e) => setRule({ ...rule, roomId: e.target.value || undefined })} className={SELECT}>
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
            onClick={() => {
              update({ rules: [...prefs.rules, { id: crypto.randomUUID().slice(0, 12), action: rule.action!, roomId: rule.roomId }] });
              setRule({ action: 'digest' });
            }}
          >
            <Plus size={14} /> Add rule
          </Button>
        </div>
      </Card>

      <Button variant="primary" busy={busy} onClick={save}>
        Save preferences
      </Button>
    </>
  );
}

export function PrivacySection() {
  const me = useStore((s) => s.me)!;
  const change = (patch: Parameters<typeof updateMe>[0]) => updateMe(patch).catch(toastError);
  return (
    <>
      <PageTitle title="Privacy" hint="What other people can see about you." />
      <Card title="Who can see your photo">
        <div role="radiogroup" aria-label="Who can see your photo" className="grid gap-3 py-3 sm:grid-cols-2">
          <Choice label="Public" hint="Anyone on Strata, including when they search for you." selected={!me.avatarPrivate} onSelect={() => void change({ avatarPrivate: false })} />
          <Choice label="Private" hint="Only people you share a conversation with." selected={me.avatarPrivate} onSelect={() => void change({ avatarPrivate: true })} />
        </div>
        <p className="py-3 text-[13px] text-ink-2">Guests on a shared link never see profile photos.</p>
      </Card>
      <Card title="Activity">
        <Row label="Show when I'm online" hint="Turn this off and you'll appear offline to everyone.">
          <Toggle
            label="Show when I'm online"
            checked={me.showOnline}
            onChange={(showOnline) => {
              void change({ showOnline }).then(() => {
                // Reconnecting is what tells everyone: presence is announced as a socket connects and leaves.
                disconnectSocket();
                connectSocket();
              });
            }}
          />
        </Row>
      </Card>
      <Card title="Your messages">
        <Row label="Encryption" hint="Messages in direct conversations, groups and branches are end-to-end encrypted. The server can't read them. Files, the Canvas, live blocks and guest branches are not, and are protected in transit and where they're stored." />
      </Card>
    </>
  );
}

const size = (bytes: number) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);

export function DataSection() {
  const [cached, setCached] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [used, setUsed] = useState<number | null>(null);

  const load = async () => {
    setCached(await db.messages.count());
    setWaiting(await db.outbox.count());
    const estimate = await navigator.storage?.estimate?.();
    setUsed(estimate?.usage ?? null);
  };
  useEffect(() => {
    void load().catch(toastError);
  }, []);

  return (
    <>
      <PageTitle title="Data and storage" hint="What Strata keeps on this device." />
      <Card title="This device">
        <Row label="Space used" hint={used === null ? 'Your browser does not report this.' : size(used)} />
        <Row label="Saved messages" hint={cached === null ? 'Counting…' : `${cached} kept for offline reading`}>
          <Button
            className="h-9 px-3 text-[13px]"
            disabled={!cached}
            onClick={() => {
              void db.messages
                .clear()
                .then(load)
                .then(() => toast('Saved messages cleared from this device'))
                .catch(toastError);
            }}
          >
            Clear
          </Button>
        </Row>
        <Row label="Waiting to send" hint={waiting ? `${waiting} will go out when you're back online. Clearing leaves these alone.` : 'Nothing waiting.'} />
      </Card>
    </>
  );
}

export function AboutSection() {
  const icon = useAppearance((s) => s.appIcon);
  const installed = window.matchMedia('(display-mode: standalone)').matches;
  const [canInstall, setCanInstall] = useState(hasInstallPrompt);
  return (
    <>
      <PageTitle title="About" hint="Conversations that crystallize instead of evaporating." />
      <Card>
        <div className="flex items-center gap-3 py-3">
          <img src={`/icons/${icon}-192.png`} alt="" className="size-14" />
          <div>
            <p className="text-sm font-bold">Strata</p>
            <p className="text-[13px] text-ink-2">Version {__APP_VERSION__}</p>
          </div>
        </div>
        <Row label="Install" hint={installed ? 'You are using the installed app.' : canInstall ? 'Add Strata to this device.' : "Use your browser's menu to add Strata to this device."}>
          {canInstall && !installed && (
            <Button
              className="h-9 px-3 text-[13px]"
              onClick={() => {
                offerInstall();
                setCanInstall(false);
              }}
            >
              <Download size={15} /> Install
            </Button>
          )}
        </Row>
      </Card>
    </>
  );
}
