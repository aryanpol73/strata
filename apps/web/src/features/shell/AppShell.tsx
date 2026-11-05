import { Bell, BellRing, GitBranch, Layers, PenSquare, Search, Settings, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { RoomDTO } from '@strata/shared';
import { api } from '../../api/client';
import { Avatar, Button, EmptyState, IconButton, Spinner, cx, shortTime } from '../../components/ui';
import { useStore } from '../../state/store';
import { NewConversationDialog, SearchDialog } from './dialogs';

export function Wordmark({ size = 20 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path d="M3 7c3-1.4 5.6 1.4 9 0s5.4-1.2 9-.2" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M3 12.5c3-1.4 5.6 1.4 9 0s5.4-1.2 9-.2" fill="none" stroke="var(--copper)" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M3 18c3-1.4 5.6 1.4 9 0s5.4-1.2 9-.2" fill="none" stroke="var(--vein)" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
      <span className="font-serif text-xl font-medium tracking-tight">Strata</span>
    </span>
  );
}

function RoomLink({ room, depth }: { room: RoomDTO; depth: number }) {
  const online = useStore((s) => s.online);
  const me = useStore((s) => s.me);
  const directOnline = room.kind === 'direct' && room.members.some((m) => m.userId !== me?.id && online[m.userId]);
  const { unread, quietUnread } = room.me;
  const isBranch = room.kind === 'branch';

  return (
    <NavLink
      to={`/r/${room.id}`}
      className={({ isActive }) => cx('relative flex items-center gap-2.5 rounded-lg px-2 transition-colors', isBranch ? 'py-1' : 'py-1.5', isActive ? 'bg-surface shadow-card' : 'hover:bg-sunken/70')}
      style={{ marginLeft: depth * 16 }}
    >
      {isBranch ? (
        <GitBranch size={14} className="ml-0.5 shrink-0 text-vein" />
      ) : (
        <Avatar name={room.name} url={room.avatarUrl} size={34} online={directOnline} />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx('truncate text-sm', unread > 0 ? 'font-semibold' : 'font-medium', isBranch && 'font-normal')}>{room.name}</span>
          {!isBranch && room.lastMessage && <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">{shortTime(room.lastMessage.at)}</span>}
        </span>
        {!isBranch && <span className="block truncate text-xs text-ink-2">{room.lastMessage ? `${room.lastMessage.senderName}: ${room.lastMessage.text}` : 'No messages yet'}</span>}
      </span>
      {unread > 0 ? (
        <span aria-label={`${unread} unread`} className="flex h-5 min-w-5 items-center justify-center rounded-full bg-copper px-1.5 text-[11px] font-semibold text-on-accent">
          {unread}
        </span>
      ) : quietUnread > 0 ? (
        <span aria-label={`${quietUnread} quiet messages`} className="size-2 rounded-full bg-lilac" />
      ) : null}
    </NavLink>
  );
}

/** Branches hang off their parent, so the shape of the list is the shape of the conversation. */
function RoomTree({ rooms }: { rooms: RoomDTO[] }) {
  const { roots, children } = useMemo(() => {
    const present = new Set(rooms.map((r) => r.id));
    const kids = new Map<string, RoomDTO[]>();
    const top: RoomDTO[] = [];
    for (const room of rooms) {
      if (room.parentRoomId && present.has(room.parentRoomId)) kids.set(room.parentRoomId, [...(kids.get(room.parentRoomId) ?? []), room]);
      else top.push(room);
    }
    return { roots: top, children: kids };
  }, [rooms]);

  const render = (room: RoomDTO, depth: number): React.ReactNode => (
    <li key={room.id}>
      <RoomLink room={room} depth={depth} />
      {!!children.get(room.id)?.length && <ul className="mt-0.5 space-y-0.5">{children.get(room.id)!.map((c) => render(c, depth + 1))}</ul>}
    </li>
  );

  return <ul className="space-y-0.5">{roots.map((r) => render(r, 0))}</ul>;
}

function NotificationBell() {
  const notifications = useStore((s) => s.notifications);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const unread = notifications.filter((n) => !n.readAt).length;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const toggle = () => {
    setOpen((v) => !v);
    if (!open && unread) {
      void api('/notifications/read', { method: 'POST', body: {} }).catch(() => {});
      useStore.getState().setNotifications(notifications.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    }
  };

  return (
    <div ref={root} className="relative">
      <IconButton label={unread ? `Notifications, ${unread} new` : 'Notifications'} aria-expanded={open} onClick={toggle}>
        {unread ? <BellRing size={18} className="text-copper" /> : <Bell size={18} />}
      </IconButton>
      {open && (
        <div className="absolute bottom-full left-0 z-40 mb-2 max-h-96 w-[min(21rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-line bg-surface p-1.5 shadow-float scroll-thin animate-rise">
          <p className="px-2 py-1 text-xs font-medium text-ink-3">Notifications</p>
          {notifications.length === 0 && <p className="px-2 py-4 text-center text-sm text-ink-3">Nothing has needed your attention.</p>}
          {notifications.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => {
                setOpen(false);
                if (n.roomId) navigate(`/r/${n.roomId}`);
              }}
              className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-sunken"
            >
              {n.kind === 'digest' ? <Layers size={15} className="mt-0.5 shrink-0 text-copper" /> : n.posture === 'blocking_ack' ? <BellRing size={15} className="mt-0.5 shrink-0 text-oxide" /> : <Bell size={15} className="mt-0.5 shrink-0 text-ink-3" />}
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{n.title}</span>
                <span className="line-clamp-2 block text-xs text-ink-2">{n.body}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar() {
  const rooms = useStore((s) => s.rooms);
  const roomsLoaded = useStore((s) => s.roomsLoaded);
  const me = useStore((s) => s.me);
  const connection = useStore((s) => s.connection);
  const [dialog, setDialog] = useState<'new' | 'search' | null>(null);

  const list = useMemo(() => Object.values(rooms).filter((r) => r.me.role), [rooms]);
  const sorted = useMemo(() => [...list].sort((a, b) => (b.lastMessage?.at ?? b.updatedAt).localeCompare(a.lastMessage?.at ?? a.updatedAt)), [list]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setDialog('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <nav aria-label="Conversations" className="flex h-full flex-col">
      <header className="flex items-center gap-1 px-3 pt-2.5 pb-2">
        <Link to="/" className="flex-1">
          <Wordmark />
        </Link>
        {connection === 'offline' && <WifiOff size={15} className="text-ink-3" aria-label="Offline" />}
        <IconButton label="Search (Ctrl K)" onClick={() => setDialog('search')}>
          <Search size={18} />
        </IconButton>
        <IconButton label="New conversation" onClick={() => setDialog('new')}>
          <PenSquare size={18} />
        </IconButton>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!roomsLoaded ? (
          <div className="flex justify-center py-8">
            <Spinner label="Loading conversations" />
          </div>
        ) : sorted.length ? (
          <RoomTree rooms={sorted} />
        ) : (
          <EmptyState title="No conversations yet" action={<Button onClick={() => setDialog('new')}>Start one</Button>}>
            Find someone by their handle to begin.
          </EmptyState>
        )}
      </div>
      <footer className="flex items-center gap-1 border-t border-line px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
        <NotificationBell />
        <span className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1">
          {me && <Avatar name={me.displayName} url={me.avatarUrl} size={26} />}
          <span className="truncate text-sm">{me?.displayName}</span>
        </span>
        <Link to="/settings" aria-label="Settings" title="Settings" className="flex size-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-sunken hover:text-ink">
          <Settings size={16} />
        </Link>
      </footer>
      {dialog === 'new' && <NewConversationDialog onClose={() => setDialog(null)} />}
      {dialog === 'search' && <SearchDialog onClose={() => setDialog(null)} />}
    </nav>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const inner = pathname !== '/';
  return (
    <div className="flex h-dvh overflow-hidden">
      {/* On phones the list and the conversation are separate screens rather than a squeezed desktop. */}
      <aside className={cx('w-full shrink-0 border-r border-line bg-paper lg:block lg:w-72', inner && 'max-lg:hidden')}>
        <Sidebar />
      </aside>
      <div className={cx('min-w-0 flex-1', !inner && 'max-lg:hidden')}>
        <Outlet />
      </div>
    </div>
  );
}

export function HomeEmpty() {
  return (
    <div className="flex h-full items-center justify-center bg-paper">
      <EmptyState title="Conversations that settle into something useful">Pick a conversation, or start one. Branch off when a topic needs room, and keep what matters on the Canvas.</EmptyState>
    </div>
  );
}
