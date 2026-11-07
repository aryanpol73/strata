import { Bell, BellRing, GitMerge, Layers, Moon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { NotificationDTO, NotificationPreferences } from '@strata/shared';
import { api } from '../../api/client';
import { Button, EmptyState, cx, shortTime } from '../../components/ui';
import { acknowledge, loadNotifications } from '../../state/actions';
import { toastError, useStore } from '../../state/store';

const FILTERS = [
  ['all', 'All'],
  ['needs', 'Needs you'],
  ['digest', 'Digests'],
] as const;

type Filter = (typeof FILTERS)[number][0];

function nextDigest(prefs: NotificationPreferences) {
  const now = new Date();
  const today = now.toTimeString().slice(0, 5);
  const windows = [...prefs.digestWindows].sort();
  const next = windows.find((w) => w > today);
  return next ? `Today at ${next}` : `Tomorrow at ${windows[0]}`;
}

function iconFor(n: NotificationDTO): { icon: ReactNode; tone: string } {
  if (n.kind === 'digest') return { icon: <Layers size={18} />, tone: 'bg-tint-violet text-violet' };
  if (n.posture === 'blocking_ack') return { icon: <BellRing size={18} />, tone: 'bg-tint-alert text-alert' };
  if (n.body.startsWith('Resolved:')) return { icon: <GitMerge size={18} />, tone: 'bg-tint-crystal text-crystal' };
  return { icon: <Bell size={18} />, tone: 'bg-tint-plain text-ink-2' };
}

function NeedsYouCard({ item }: { item: ReturnType<typeof useStore.getState>['needsYou'][number] }) {
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  return (
    <li className="flex gap-3 rounded-2xl border border-line-strong bg-raised p-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-alert text-alert">
        <BellRing size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{item.excerpt}</p>
        <p className="text-[13px] text-ink-2">
          {item.senderName} in {item.roomName}, by {new Date(item.deadline).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
        </p>
        <div className="mt-2 flex gap-2">
          <Button
            variant="danger"
            busy={busy}
            className="h-9 px-3 text-[13px]"
            onClick={() => {
              setBusy(true);
              acknowledge(item.messageId)
                .catch(toastError)
                .finally(() => setBusy(false));
            }}
          >
            Acknowledge
          </Button>
          <Button className="h-9 px-3 text-[13px]" onClick={() => navigate(`/r/${item.roomId}?m=${item.seq}`)}>
            Open
          </Button>
        </div>
      </div>
    </li>
  );
}

interface DigestQueue {
  total: number;
  nextAt: string | null;
  items: { roomId: string; roomName: string; count: number }[];
}

/** Waiting should never be a mystery: this is exactly what's held, when it will arrive, and a way to skip the wait. */
function DigestCard({ windows, onSent, latest }: { windows: string[]; onSent: () => void; latest?: string }) {
  const [queue, setQueue] = useState<DigestQueue | null>(null);
  const [busy, setBusy] = useState(false);
  // The click and the digest arriving both ask for a refresh, and the first answer can land last. Only the newest counts.
  const latestAsk = useRef(0);
  const load = () => {
    const mine = ++latestAsk.current;
    return api<DigestQueue>('/notifications/digest-queue')
      .then((q) => mine === latestAsk.current && setQueue(q))
      .catch(() => {});
  };
  // A digest arriving is what empties the queue, so that's when to look again. The click only asks for it.
  useEffect(() => {
    void load();
  }, [latest]);
  if (!queue) return null;

  if (queue.total === 0) {
    return (
      <section aria-label="Held for your digest" className="mb-4 rounded-2xl border border-line bg-surface p-3.5">
        <h2 className="text-sm font-bold">Held for your digest</h2>
        <p className="mt-1 text-[13px] text-ink-2">
          Nothing is waiting. Messages sent as Digest, or from conversations you've set to Digest only, wait here until {windows.join(' or ')}.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Held for your digest" className="mb-4 rounded-2xl border border-line-strong bg-raised p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold">
            {queue.total} {queue.total === 1 ? 'message' : 'messages'} held for your digest
          </h2>
          {queue.nextAt && <p className="text-[13px] text-ink-2">Arrives {new Date(queue.nextAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</p>}
        </div>
        <Button
          variant="primary"
          className="h-9 shrink-0 px-3 text-[13px]"
          busy={busy}
          onClick={() => {
            setBusy(true);
            api('/notifications/digest/flush', { method: 'POST' })
              .then(() => {
                onSent();
                // Delivery happens a moment after the click, and anything already read is dropped without a notification,
                // so there may be nothing arriving to prompt a refresh. Look again shortly instead.
                for (const wait of [0, 1500, 4000]) setTimeout(() => void load(), wait);
              })
              .catch(toastError)
              .finally(() => setBusy(false));
          }}
        >
          Send now
        </Button>
      </div>
      <ul className="mt-2 divide-y divide-line text-sm">
        {queue.items.map((i) => (
          <li key={i.roomId} className="flex items-center justify-between py-1.5">
            <Link to={`/r/${i.roomId}`} className="min-w-0 truncate font-medium hover:underline">
              {i.roomName}
            </Link>
            <span className="font-mono text-xs text-ink-2">{i.count}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AttentionPage() {
  const notifications = useStore((s) => s.notifications);
  const needsYou = useStore((s) => s.needsYou);
  const [filter, setFilter] = useState<Filter>('all');
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);

  useEffect(() => {
    api<{ preferences: NotificationPreferences }>('/notifications/preferences')
      .then((r) => setPrefs(r.preferences))
      .catch(() => {});
  }, []);

  // Opening this page is reading it.
  useEffect(() => {
    if (!notifications.some((n) => !n.readAt)) return;
    void api('/notifications/read', { method: 'POST', body: {} }).catch(() => {});
    useStore.getState().setNotifications(notifications.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
  }, [notifications]);

  const list = useMemo(() => notifications.filter((n) => (filter === 'digest' ? n.kind === 'digest' : filter === 'needs' ? false : true)), [notifications, filter]);
  const showNeeds = filter !== 'digest' && needsYou.length > 0;

  return (
    <div className="flex h-full">
      <nav aria-label="Filter notifications" className="hidden w-80 shrink-0 flex-col gap-1 border-r border-line bg-basin p-4 lg:flex">
        <h1 className="mb-3 text-2xl font-bold tracking-tight">Attention</h1>
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={cx('st-press flex items-center justify-between rounded-xl px-3 py-2.5 text-sm font-semibold', filter === id ? 'bg-tint-violet text-violet' : 'text-ink-2 hover:bg-tint-plain')}>
            {label}
            {id === 'needs' && needsYou.length > 0 && <span className="font-mono text-[11px]">{needsYou.length}</span>}
          </button>
        ))}
      </nav>

      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto px-4 pt-3 pb-28 lg:px-6 lg:pb-6">
        <h1 className="mb-3 text-2xl font-bold tracking-tight lg:hidden">Attention</h1>
        <div className="mb-3 flex gap-2 lg:hidden">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={cx('st-press rounded-full px-3 py-1.5 text-[13px] font-semibold', filter === id ? 'st-primary' : 'border border-line text-ink-2')}>
              {label}
            </button>
          ))}
        </div>

        {filter !== 'needs' && <DigestCard latest={notifications[0]?.id} windows={prefs?.digestWindows ?? ['09:00', '17:30']} onSent={() => void loadNotifications().catch(() => {})} />}

        {showNeeds && (
          <section aria-label="Needs you" className="mb-4">
            <h2 className="mb-2 text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Needs you</h2>
            <ul className="space-y-2">
              {needsYou.map((item) => (
                <NeedsYouCard key={item.messageId} item={item} />
              ))}
            </ul>
          </section>
        )}

        {list.length > 0 && (
          <section aria-label="Recent">
            <h2 className="mb-2 text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Recent</h2>
            <ul className="space-y-2">
              {list.map((n) => {
                const { icon, tone } = iconFor(n);
                return (
                  <li key={n.id}>
                    <Link to={n.roomId ? `/r/${n.roomId}` : '/'} className="st-press flex gap-3 rounded-2xl border border-line bg-surface p-3 hover:border-line-strong">
                      <span className={cx('flex size-10 shrink-0 items-center justify-center rounded-xl', tone)}>{icon}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate font-semibold">{n.title}</span>
                          {n.sentAt && <span className="font-mono text-[11px] text-ink-3">{shortTime(n.sentAt)}</span>}
                        </span>
                        <span className="line-clamp-2 block text-[13px] text-ink-2">{n.body}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!showNeeds && list.length === 0 && <EmptyState title="Nothing needs your attention">When something does, it will appear here.</EmptyState>}
      </main>

      <aside aria-label="Your attention" className="hidden w-[380px] shrink-0 flex-col gap-3 border-l border-line bg-sheet p-4 xl:flex">
        <h2 className="text-[17px] font-bold">Your attention</h2>
        {prefs && (
          <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
            <li className="flex items-center gap-3 border-b border-line p-3">
              <span className="flex size-9 items-center justify-center rounded-xl bg-tint-violet text-violet">
                <Layers size={16} />
              </span>
              <span>
                <span className="block text-sm font-semibold">Next digest</span>
                <span className="text-[13px] text-ink-2">{nextDigest(prefs)}</span>
              </span>
            </li>
            <li className="flex items-center gap-3 p-3">
              <span className="flex size-9 items-center justify-center rounded-xl bg-tint-plain text-ink-2">
                <Moon size={16} />
              </span>
              <span>
                <span className="block text-sm font-semibold">Quiet hours</span>
                <span className="text-[13px] text-ink-2">{prefs.quietHours.enabled ? `${prefs.quietHours.start} to ${prefs.quietHours.end}` : 'Off'}</span>
              </span>
            </li>
          </ul>
        )}
        <p className="text-[13px] text-ink-2">Your rules always win over how a sender chose to reach you.</p>
        <Link to="/settings/notifications" className="st-press inline-flex h-10 items-center justify-center rounded-xl border border-line-strong bg-raised text-sm font-semibold hover:border-violet">
          Edit rules
        </Link>
      </aside>
    </div>
  );
}
