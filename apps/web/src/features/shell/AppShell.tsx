import { Bell, BellRing, GitBranch, MessagesSquare, Plus, Search, User, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAppearance } from '../settings/appearance';
import { useE2ee } from '../e2ee/service';
import { NotificationPrompt } from './NotificationPrompt';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import type { RoomDTO } from '@strata/shared';
import { Avatar, Button, EmptyState, IconButton, Pill, Spinner, cx, shortTime } from '../../components/ui';
import { useStore } from '../../state/store';
import { NewConversationDialog, SearchDialog } from './dialogs';

export function Wordmark({ size = 20, mark = false }: { size?: number; mark?: boolean }) {
  const icon = useAppearance((a) => a.appIcon);
  return (
    <span className="inline-flex items-center gap-2">
      <img src={`/icons/${icon}-192.png`} width={size} height={size} alt={mark ? 'Strata' : ''} />
      {!mark && <span className="text-xl font-bold tracking-tight">Strata</span>}
    </span>
  );
}

const branchTone = (room: RoomDTO) => (room.branch?.mergedAt || room.branch?.status === 'resolved' ? 'crystal' : room.branch?.status === 'open' ? 'branch' : 'plain');
const branchLabel = (room: RoomDTO) => (room.branch?.mergedAt ? 'Merged' : room.branch?.status === 'resolved' ? 'Resolved' : room.branch?.status === 'open' ? 'Open' : 'Archived');

function Counts({ room }: { room: RoomDTO }) {
  const { unread, quietUnread } = room.me;
  if (unread > 0) {
    return (
      <span aria-label={`${unread} unread`} className="flex h-5 min-w-5 items-center justify-center rounded-full bg-violet-fill px-1.5 text-[11px] font-bold text-on-violet">
        {unread}
      </span>
    );
  }
  return quietUnread > 0 ? <span aria-label={`${quietUnread} quiet messages`} className="size-2 rounded-full bg-whisper" /> : null;
}

function ConversationCard({ room }: { room: RoomDTO }) {
  const online = useStore((s) => s.online);
  const me = useStore((s) => s.me);
  const preview = useE2ee((s) => s.previews[room.id]);
  const lastText = preview && preview.seq === room.lastMessage?.seq ? preview.text : room.lastMessage?.text;
  const directOnline = room.kind === 'direct' && room.members.some((m) => m.userId !== me?.id && online[m.userId]);
  return (
    <NavLink to={`/r/${room.id}`} className={({ isActive }) => cx('st-press flex items-center gap-3 rounded-[20px] border p-3', isActive ? 'border-violet bg-tint-violet' : 'border-line bg-surface hover:border-line-strong')}>
      <Avatar name={room.name} url={room.avatarUrl} size={44} online={directOnline} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx('truncate text-[15px]', room.me.unread > 0 ? 'font-bold' : 'font-semibold')}>{room.name}</span>
          {room.lastMessage && <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-3">{shortTime(room.lastMessage.at)}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{room.lastMessage ? `${room.lastMessage.senderName}: ${lastText}` : 'No messages yet'}</span>
          <Counts room={room} />
        </span>
      </span>
    </NavLink>
  );
}

function BranchRow({ room, depth }: { room: RoomDTO; depth: number }) {
  return (
    <NavLink
      to={`/r/${room.id}`}
      style={{ marginLeft: 24 + (depth - 1) * 14 }}
      className={({ isActive }) => cx('st-press flex items-center gap-2 rounded-r-xl border-l-2 border-branch px-3 py-2 text-[13px]', isActive ? 'bg-tint-branch text-ink' : 'text-ink-2 hover:bg-tint-plain')}
    >
      <GitBranch size={14} className="shrink-0 text-branch" />
      <span className="min-w-0 flex-1 truncate">{room.name}</span>
      <Counts room={room} />
      <Pill tone={branchTone(room)}>{branchLabel(room)}</Pill>
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

  const render = (room: RoomDTO, depth: number): ReactNode => (
    <li key={room.id}>
      {depth === 0 && room.kind !== 'branch' ? <ConversationCard room={room} /> : <BranchRow room={room} depth={Math.max(depth, 1)} />}
      {!!children.get(room.id)?.length && <ul className="mt-1 space-y-1">{children.get(room.id)!.map((c) => render(c, depth + 1))}</ul>}
    </li>
  );

  return <ul className="space-y-2">{roots.map((r) => render(r, 0))}</ul>;
}

function NeedsYouStrip() {
  const items = useStore((s) => s.needsYou);
  if (!items.length) return null;
  return (
    <section aria-label="Needs you" className="mb-3">
      <h2 className="mb-1.5 text-[11px] font-bold tracking-[0.08em] text-ink-2 uppercase">Needs you</h2>
      <ul className="space-y-1.5">
        {items.slice(0, 3).map((item) => (
          <li key={item.messageId}>
            <Link to={`/r/${item.roomId}?m=${item.seq}`} className="st-press flex items-center gap-2.5 rounded-2xl border border-line-strong bg-raised p-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-tint-alert text-alert">
                <BellRing size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{item.excerpt}</span>
                <span className="block truncate text-xs text-ink-2">
                  {item.senderName}, by {new Date(item.deadline).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const FILTERS = [
  ['all', 'All'],
  ['unread', 'Unread'],
  ['quiet', 'Quiet'],
] as const;

function InboxPane({ onNew, onSearch }: { onNew: () => void; onSearch: () => void }) {
  const rooms = useStore((s) => s.rooms);
  const roomsLoaded = useStore((s) => s.roomsLoaded);
  const connection = useStore((s) => s.connection);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');

  const sorted = useMemo(
    () =>
      Object.values(rooms)
        .filter((r) => r.me.role)
        .filter((r) => filter === 'all' || (filter === 'unread' ? r.me.unread > 0 : r.me.quietUnread > 0))
        .sort((a, b) => (b.lastMessage?.at ?? b.updatedAt).localeCompare(a.lastMessage?.at ?? a.updatedAt)),
    [rooms, filter],
  );

  return (
    <nav aria-label="Conversations" className="flex h-full flex-col bg-basin">
      <header className="flex items-center gap-1 px-4 pt-3 pb-2">
        <h1 className="min-w-0 flex-1 text-2xl font-bold tracking-tight">Inbox</h1>
        {connection === 'offline' && <WifiOff size={15} className="text-ink-3" aria-label="Offline" />}
        <IconButton label="Search (Ctrl K)" onClick={onSearch} className="lg:hidden">
          <Search size={18} />
        </IconButton>
        <IconButton label="New conversation" onClick={onNew} className="max-lg:hidden">
          <Plus size={18} className="i-spin" />
        </IconButton>
      </header>
      <div className="flex gap-2 px-4 pb-3">
        {FILTERS.map(([id, label]) => (
          <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={cx('st-press rounded-full px-3 py-1.5 text-[13px] font-semibold', filter === id ? 'st-primary' : 'border border-line text-ink-2 hover:border-line-strong')}>
            {label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-28 lg:pb-3">
        <NotificationPrompt />
        <NeedsYouStrip />
        {!roomsLoaded ? (
          <div className="flex justify-center py-8">
            <Spinner label="Loading conversations" />
          </div>
        ) : sorted.length ? (
          <RoomTree rooms={sorted} />
        ) : filter === 'all' ? (
          <EmptyState title="No conversations yet" action={<Button variant="primary" onClick={onNew}>Start one</Button>}>
            Find someone by their handle to begin.
          </EmptyState>
        ) : (
          <EmptyState title="Nothing here">You're all caught up.</EmptyState>
        )}
      </div>
    </nav>
  );
}

function useAttentionCount() {
  return useStore((s) => s.notifications.filter((n) => !n.readAt).length);
}

function Rail({ onSearch }: { onSearch: () => void }) {
  const me = useStore((s) => s.me);
  const unread = useAttentionCount();
  const needsYou = useStore((s) => s.needsYou.length);
  const item = ({ isActive }: { isActive: boolean }) => cx('st-press relative flex size-11 items-center justify-center rounded-xl', isActive ? 'bg-tint-violet text-violet' : 'text-ink-2 hover:bg-tint-plain hover:text-ink');
  return (
    <nav aria-label="Main" className="hidden w-[72px] shrink-0 flex-col items-center gap-2 border-r border-line py-4 lg:flex">
      <Link to="/" aria-label="Strata home" className="mb-3">
        <Wordmark size={36} mark />
      </Link>
      <NavLink to="/" end aria-label="Inbox" title="Inbox" className={item}>
        <MessagesSquare size={20} />
      </NavLink>
      <NavLink to="/branches" aria-label="Branches" title="Branches" className={item}>
        <GitBranch size={20} />
      </NavLink>
      <NavLink to="/attention" aria-label={unread ? `Attention, ${unread} new` : 'Attention'} title="Attention" className={item}>
        {needsYou || unread ? <BellRing size={20} /> : <Bell size={20} />}
        {(needsYou > 0 || unread > 0) && <span aria-hidden className={cx('absolute top-2 right-2 size-2 rounded-full', needsYou ? 'bg-alert' : 'bg-violet')} />}
      </NavLink>
      <IconButton label="Search (Ctrl K)" onClick={onSearch} className="size-11">
        <Search size={20} />
      </IconButton>
      <span className="flex-1" />
      <NavLink to="/settings" aria-label="You" title="You" className="st-press rounded-full">
        {me && <Avatar name={me.displayName} url={me.avatarUrl} size={36} />}
      </NavLink>
    </nav>
  );
}

function TabBar({ onNew }: { onNew: () => void }) {
  const unread = useAttentionCount();
  const needsYou = useStore((s) => s.needsYou.length);
  const tab = ({ isActive }: { isActive: boolean }) => cx('st-press relative flex h-13 w-15 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-semibold', isActive ? 'text-violet' : 'text-ink-2');
  return (
    <nav aria-label="Main" className="st-glass fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 flex h-16 items-center justify-between rounded-[28px] px-2 shadow-float lg:hidden">
      <NavLink to="/" end className={tab}>
        <MessagesSquare size={20} /> Inbox
      </NavLink>
      <NavLink to="/branches" className={tab}>
        <GitBranch size={20} /> Branches
      </NavLink>
      <button type="button" aria-label="New conversation" onClick={onNew} className="st-press st-primary flex size-12 shrink-0 items-center justify-center rounded-full">
        <Plus size={20} className="i-spin" />
      </button>
      <NavLink to="/attention" aria-label={unread ? `Attention, ${unread} new` : 'Attention'} className={tab}>
        <Bell size={20} /> Attention
        {(needsYou > 0 || unread > 0) && <span aria-hidden className={cx('absolute top-1.5 right-4 size-2 rounded-full', needsYou ? 'bg-alert' : 'bg-violet')} />}
      </NavLink>
      <NavLink to="/settings" className={tab}>
        <User size={20} /> You
      </NavLink>
    </nav>
  );
}

export function AppShell() {
  const { pathname } = useLocation();
  const [dialog, setDialog] = useState<'new' | 'search' | null>(null);
  const inConversation = pathname.startsWith('/r/');
  const showInbox = pathname === '/' || inConversation;

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
    <div className="st-void flex h-dvh overflow-hidden">
      <Rail onSearch={() => setDialog('search')} />
      {/* On phones the list and the conversation are separate screens rather than a squeezed desktop. */}
      {showInbox && (
        <aside className={cx('w-full shrink-0 border-r border-line lg:block lg:w-80', inConversation && 'max-lg:hidden')}>
          <InboxPane onNew={() => setDialog('new')} onSearch={() => setDialog('search')} />
        </aside>
      )}
      <div className={cx('min-w-0 flex-1', pathname === '/' && 'max-lg:hidden')}>
        <Outlet />
      </div>
      {!inConversation && <TabBar onNew={() => setDialog('new')} />}
      {dialog === 'new' && <NewConversationDialog onClose={() => setDialog(null)} />}
      {dialog === 'search' && <SearchDialog onClose={() => setDialog(null)} />}
    </div>
  );
}

export function HomeEmpty() {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState title="Conversations that settle into something useful">Pick a conversation, or start one. Branch off when a topic needs room, and keep what matters on the Canvas.</EmptyState>
    </div>
  );
}
