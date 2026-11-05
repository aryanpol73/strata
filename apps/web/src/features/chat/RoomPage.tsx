import {
  Archive,
  ArrowLeft,
  Bookmark,
  CheckCircle2,
  ChevronRight,
  GitBranch,
  GitMerge,
  Info,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  UserPlus,
  Users,
  Waypoints,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type {
  BranchSummaryDTO,
  DeliveryStatusDTO,
  MediaUrlDTO,
  MessageDTO,
  MessageReferenceDTO,
  RoomDTO,
} from '@strata/shared';
import { ApiError, api } from '../../api/client';
import { Avatar, Button, Dialog, EmptyState, IconButton, Pill, Spinner, cx, dayLabel, timeLabel } from '../../components/ui';
import { getSocket, type StrataSocket } from '../../realtime/socket';
import { loadMessages, loadOlder, loadRoom, markRead, retryPending } from '../../state/actions';
import { toast, toastError, useStore, type PendingMessage } from '../../state/store';
import { BlockCard } from '../blocks/BlockCard';
import { AddParticipantsDialog, CreateBranchDialog, GuestDialog, MergeDialog, ResolveDialog } from '../branches/dialogs';
import { CanvasPanel } from '../canvas/CanvasPanel';
import { RoomInfoDialog } from '../shell/dialogs';
import { Composer } from './Composer';
import { MessageBody, MessageRow, type RowActions } from './MessageRow';

const urlFor = (id: string) => api<MediaUrlDTO>(`/media/${id}/url`);

/** The Canvas mounts in exactly one place, so this has to be a real answer rather than a CSS rule. */
function useIsDesktop() {
  const [matches, setMatches] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const update = () => setMatches(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return matches;
}

function useBranches(roomId: string, trigger: unknown) {
  const [branches, setBranches] = useState<BranchSummaryDTO[]>([]);
  const load = useCallback(() => {
    api<{ branches: BranchSummaryDTO[] }>(`/rooms/${roomId}/branches`)
      .then((r) => setBranches(r.branches))
      .catch(() => setBranches([]));
  }, [roomId]);
  useEffect(() => {
    load();
    window.addEventListener('strata:branches', load);
    return () => window.removeEventListener('strata:branches', load);
  }, [load, trigger]);
  return branches;
}

function typingLine(names: string[]) {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return 'Several people are typing';
}

function TypingIndicator({ roomId }: { roomId: string }) {
  const entries = useStore((s) => s.typing[roomId]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!entries || !Object.keys(entries).length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [entries]);
  const names = Object.values(entries ?? {}).filter((t) => t.until > now).map((t) => t.name);
  return (
    <p aria-live="polite" className="h-5 px-5 text-xs text-ink-2">
      {typingLine(names)}
    </p>
  );
}

function PendingRow({ p }: { p: PendingMessage }) {
  const me = useStore((s) => s.me);
  return (
    <div className="mt-1 flex gap-2.5 px-2 opacity-70 sm:px-3">
      <div className="w-9 shrink-0">{me && <Avatar name={me.displayName} />}</div>
      <div className="min-w-0">
        <p className="whitespace-pre-wrap">{p.text}</p>
        {p.failed ? (
          <button type="button" className="text-xs text-oxide underline" onClick={() => retryPending(p).catch(toastError)}>
            Not sent. Tap to retry
          </button>
        ) : (
          <p className="text-xs text-ink-3">Sending…</p>
        )}
      </div>
    </div>
  );
}

function receiptFor(m: MessageDTO, room: RoomDTO, meId: string): string | null {
  const others = room.members.filter((x) => x.userId !== meId);
  if (!others.length) return null;
  const read = others.filter((x) => x.lastReadSeq >= m.seq).length;
  if (read === others.length) return others.length === 1 ? 'Read' : 'Read by everyone';
  if (read > 0) return `Read by ${read}`;
  return others.every((x) => x.lastDeliveredSeq >= m.seq) ? 'Delivered' : 'Sent';
}

function Stream({
  room,
  focusSeq,
  branches,
  actions,
  socket,
}: {
  room: RoomDTO;
  focusSeq: number | null;
  branches: BranchSummaryDTO[];
  actions: RowActions;
  socket: StrataSocket | null;
}) {
  const me = useStore((s) => s.me)!;
  const data = useStore((s) => s.messages[room.id]);
  const pending = useStore((s) => s.pending[room.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const heightBeforeOlder = useRef<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    setDenied(false);
    pinned.current = !focusSeq;
    loadMessages(room.id, focusSeq ?? undefined).catch((err) => {
      if (err instanceof ApiError && err.status === 404) setDenied(true);
      else toastError(err);
    });
  }, [room.id, focusSeq]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const last = items.at(-1);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (heightBeforeOlder.current !== null) {
      el.scrollTop += el.scrollHeight - heightBeforeOlder.current;
      heightBeforeOlder.current = null;
    } else if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [items, pending]);

  useEffect(() => {
    if (focusSeq) document.getElementById(`m-${focusSeq}`)?.scrollIntoView({ block: 'center' });
  }, [focusSeq, items.length]);

  // Reading is something you do with your eyes on the latest message, in a visible tab.
  useEffect(() => {
    const check = () => {
      if (last && pinned.current && document.visibilityState === 'visible') markRead(room.id, last.seq);
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [last, room.id]);

  const onScroll = async () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (pinned.current && last) markRead(room.id, last.seq);
    if (el.scrollTop < 120 && data?.hasMore && !loadingOlder) {
      setLoadingOlder(true);
      heightBeforeOlder.current = el.scrollHeight;
      await loadOlder(room.id).catch(toastError);
      setLoadingOlder(false);
    }
  };

  const byMessage = useMemo(() => {
    const map = new Map<string, BranchSummaryDTO[]>();
    for (const b of branches) map.set(b.parentMessageId, [...(map.get(b.parentMessageId) ?? []), b]);
    return map;
  }, [branches]);

  const myLast = [...items].reverse().find((m) => m.sender.id === me.id && !m.deletedAt);
  const isAdmin = room.me.role === 'owner' || room.me.role === 'admin';
  const readOnly = room.me.readOnly;

  if (denied) return <EmptyState title="This conversation isn't available">It may not exist, or you may not have access.</EmptyState>;

  return (
    <div ref={scroller} onScroll={onScroll} role="log" aria-label="Messages" className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1 pb-2 sm:px-2">
      {room.branch?.origin && (
        <div className="mx-2 mt-3 mb-1 rounded-lg border-l-2 border-vein bg-vein-soft/40 px-3 py-2 sm:mx-3">
          <p className="text-xs font-medium text-vein">Branched from</p>
          <Link to={`/r/${room.parentRoomId}?m=${room.branch.origin.seq}`} className="block text-sm hover:underline">
            <span className="font-medium">{room.branch.origin.senderName}</span> <span className="text-ink-2">{room.branch.origin.excerpt}</span>
          </Link>
        </div>
      )}
      {loadingOlder && (
        <div className="flex justify-center py-2">
          <Spinner label="Loading older messages" />
        </div>
      )}
      {!data?.loaded && !items.length && (
        <div className="flex justify-center py-10">
          <Spinner label="Loading messages" />
        </div>
      )}
      {data?.loaded && !items.length && <EmptyState title="Nothing here yet">Say something, or start with a checklist from the plus menu.</EmptyState>}

      {items.map((m, i) => {
        const prev = items[i - 1];
        const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
        const compact =
          !newDay &&
          prev?.sender.id === m.sender.id &&
          prev.payload.type !== 'system' &&
          new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
        const mine = m.sender.id === me.id;
        return (
          <div key={m.id}>
            {newDay && (
              <div className="my-3 flex items-center gap-3 px-3">
                <span className="h-px flex-1 bg-line" />
                <span className="font-mono text-[11px] text-ink-3">{dayLabel(m.createdAt)}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            )}
            <MessageRow
              m={m}
              compact={compact}
              meId={me.id}
              mine={mine}
              isAdmin={isAdmin}
              readOnly={readOnly}
              branches={byMessage.get(m.id) ?? []}
              actions={actions}
              highlighted={focusSeq === m.seq}
              canOpenResolution={m.payload.type === 'resolution' && branches.some((b) => b.roomId === (m.payload as { branchRoomId: string }).branchRoomId && b.canReadTranscript)}
              receipt={myLast?.id === m.id ? receiptFor(m, room, me.id) : null}
              body={
                <MessageBody
                  m={m}
                  urlFor={urlFor}
                  renderBlock={(p) => <BlockCard blockId={p.blockId} type={p.blockType} fallbackTitle={p.title} socket={socket} actor={{ id: me.id, name: me.displayName }} />}
                />
              }
            />
          </div>
        );
      })}
      {pending?.map((p) => <PendingRow key={p.clientMessageId} p={p} />)}
    </div>
  );
}

function DeliveryDialog({ message, onClose }: { message: MessageDTO; onClose: () => void }) {
  const [status, setStatus] = useState<DeliveryStatusDTO | null>(null);
  useEffect(() => {
    api<{ status: DeliveryStatusDTO }>(`/messages/${message.id}/delivery`)
      .then((r) => setStatus(r.status))
      .catch(toastError);
  }, [message.id]);

  const describe = (r: DeliveryStatusDTO['recipients'][number]) => {
    if (r.state === 'none') return 'In the conversation, no notification';
    if (r.state === 'sent') return `Notified at ${timeLabel(r.sentAt!)}`;
    if (r.state === 'failed') return 'Could not notify';
    if (r.state === 'suppressed') return r.reason === 'already_read' ? 'Read before notifying' : r.reason === 'acknowledged' ? 'Acknowledged' : 'Held by their settings';
    const when = new Date(r.dueAt!).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return r.reason === 'digest_window' ? `In their digest, ${when}` : r.reason === 'quiet_hours' ? `After their quiet hours, ${when}` : 'Notifying now';
  };

  return (
    <Dialog title="Delivery status" onClose={onClose}>
      {!status ? (
        <Spinner />
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-2">Everyone can see this message in the conversation. This shows how each person was told about it.</p>
          <ul className="divide-y divide-line">
            {status.recipients.map((r) => {
              const ack = status.ack?.required.find((x) => x.userId === r.userId);
              return (
                <li key={r.userId} className="flex items-center gap-2.5 py-2">
                  <Avatar name={r.name} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.name}</p>
                    <p className="text-xs text-ink-2">{describe(r)}</p>
                  </div>
                  {ack && <Pill tone={ack.ackedAt ? 'vein' : 'oxide'}>{ack.ackedAt ? 'Acknowledged' : 'Waiting'}</Pill>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Dialog>
  );
}

function ReferencesDialog({ refs, onClose, onCanvas, onOpen }: { refs: MessageReferenceDTO[]; onClose: () => void; onCanvas: (id: string) => void; onOpen: (r: MessageReferenceDTO) => void }) {
  return (
    <Dialog title="References to this message" onClose={onClose}>
      <ul>
        {refs.map((r) => (
          <li key={`${r.kind}-${r.id}`}>
            <button type="button" onClick={() => (r.kind === 'canvas' ? onCanvas(r.id) : onOpen(r))} className="flex w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left text-sm transition hover:bg-sunken">
              {r.kind === 'canvas' ? <Bookmark size={15} className="text-copper" /> : r.kind === 'branch' ? <GitBranch size={15} className="text-vein" /> : <Waypoints size={15} className="text-ink-2" />}
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function BranchBar({ room, onResolve, onMerge, onGuests, onAdd }: { room: RoomDTO; onResolve: () => void; onMerge: () => void; onGuests: () => void; onAdd: () => void }) {
  const branch = room.branch!;
  const me = useStore((s) => s.me);
  const manages = room.me.role === 'owner' || branch.createdBy === me?.id;
  const merged = !!branch.mergedAt;

  const act = async (path: string) => {
    try {
      await api(`/branches/${room.id}/${path}`, { method: 'POST' });
      await loadRoom(room.id);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-vein-soft/30 px-3 py-1.5 sm:px-5">
      <Pill tone={merged ? 'copper' : branch.status === 'open' ? 'vein' : branch.status === 'resolved' ? 'copper' : 'plain'}>{merged ? 'Merged' : branch.status}</Pill>
      {branch.visibility === 'private' && <Pill tone="plain">Private</Pill>}
      <span className="flex-1" />
      {!room.me.readOnly && branch.status === 'open' && (
        <>
          <Button className="h-8 text-xs" onClick={onGuests}>
            <UserPlus size={14} /> <span className="max-sm:hidden">Invite guest</span>
          </Button>
          {manages && (
            <Button className="h-8 text-xs" onClick={onAdd}>
              <Users size={14} /> <span className="max-sm:hidden">Add people</span>
            </Button>
          )}
          {manages && (
            <Button variant="primary" className="h-8 text-xs" onClick={onResolve}>
              <CheckCircle2 size={14} /> Resolve
            </Button>
          )}
        </>
      )}
      {manages && branch.status === 'resolved' && !merged && (
        <>
          <Button className="h-8 text-xs" onClick={() => act('reopen')}>
            <RotateCcw size={14} /> Reopen
          </Button>
          <Button variant="vein" className="h-8 text-xs" onClick={onMerge}>
            <GitMerge size={14} /> Merge resolution
          </Button>
        </>
      )}
      {manages && branch.status !== 'archived' && branch.status !== 'open' && (
        <IconButton label="Archive branch" className="size-8" onClick={() => act('archive')}>
          <Archive size={15} />
        </IconButton>
      )}
    </div>
  );
}

export function RoomPage() {
  const { roomId = '' } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const room = useStore((s) => s.rooms[roomId]);
  const parent = useStore((s) => (room?.parentRoomId ? s.rooms[room.parentRoomId] : undefined));
  const online = useStore((s) => s.online);
  const me = useStore((s) => s.me)!;
  const canvasOpen = useStore((s) => s.canvasOpen);
  const setCanvasOpen = useStore((s) => s.setCanvasOpen);
  const connection = useStore((s) => s.connection);

  const [missing, setMissing] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  const [branchFrom, setBranchFrom] = useState<MessageDTO | null>(null);
  const [delivery, setDelivery] = useState<MessageDTO | null>(null);
  const [refs, setRefs] = useState<MessageReferenceDTO[] | null>(null);
  const [dialog, setDialog] = useState<'resolve' | 'merge' | 'guests' | 'add' | 'info' | null>(null);
  const [mobileView, setMobileView] = useState<'stream' | 'canvas'>('stream');
  const [focusBlock, setFocusBlock] = useState<string | null>(null);
  const isDesktop = useIsDesktop();
  const showCanvasInline = !isDesktop && mobileView === 'canvas';

  const focusParam = Number(params.get('m'));
  const focusSeq = Number.isInteger(focusParam) && focusParam > 0 ? focusParam : null;

  useEffect(() => {
    setMissing(false);
    setReplyTo(null);
    setFocusBlock(null);
    setMobileView('stream');
    if (!useStore.getState().rooms[roomId]) {
      loadRoom(roomId).catch(() => setMissing(true));
    }
  }, [roomId]);

  const branchVersion = useStore((s) => s.messages[roomId]?.items.reduce((n, m) => n + m.branchCount, 0));
  const branches = useBranches(roomId, branchVersion);

  const showBlock = useCallback(
    (id: string) => {
      setFocusBlock(id);
      setCanvasOpen(true);
      setMobileView('canvas');
      setRefs(null);
    },
    [setCanvasOpen],
  );

  const actions: RowActions = useMemo(
    () => ({
      onReply: setReplyTo,
      onBranch: setBranchFrom,
      onCanvas: async (m) => {
        try {
          const { block } = await api<{ block: { id: string } }>(`/rooms/${m.roomId}/canvas/blocks`, { method: 'POST', body: { fromMessageId: m.id } });
          showBlock(block.id);
          toast('Added to Canvas');
        } catch (err) {
          toastError(err);
        }
      },
      onReact: (m, emoji) => void api(`/messages/${m.id}/reactions`, { method: 'POST', body: { emoji } }).catch(toastError),
      onEdit: (m, text) => void api(`/messages/${m.id}`, { method: 'PATCH', body: { text } }).catch(toastError),
      onDelete: (m) => {
        if (confirm('Delete this message for everyone?')) void api(`/messages/${m.id}`, { method: 'DELETE' }).catch(toastError);
      },
      onDelivery: setDelivery,
      onAck: (m) => void api(`/messages/${m.id}/ack`, { method: 'POST' }).catch(toastError),
      onOpenBranch: (id) => navigate(`/r/${id}`),
      onShowRefs: async (m) => {
        try {
          const { references } = await api<{ references: MessageReferenceDTO[] }>(`/messages/${m.id}/references`);
          const canvas = references.filter((r) => r.kind === 'canvas');
          if (canvas.length === 1 && references.length === 1) showBlock(canvas[0]!.id);
          else setRefs(references);
        } catch (err) {
          toastError(err);
        }
      },
    }),
    [navigate, showBlock],
  );

  if (missing) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState title="This conversation isn't available" action={<Button onClick={() => navigate('/')}>Back to conversations</Button>}>
          It may not exist, or you may not have access.
        </EmptyState>
      </div>
    );
  }
  if (!room) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const otherOnline = room.kind === 'direct' && room.members.some((m) => m.userId !== me.id && online[m.userId]);
  const subtitle =
    room.kind === 'direct'
      ? otherOnline
        ? 'Online'
        : 'Offline'
      : `${room.members.length} ${room.members.length === 1 ? 'person' : 'people'}${room.kind === 'group' ? ` · ${room.members.filter((m) => online[m.userId] || m.userId === me.id).length} online` : ''}`;

  const closedReason = room.me.readOnly
    ? 'This is a read-only transcript of a merged branch.'
    : room.kind === 'branch' && room.branch?.status !== 'open'
      ? room.branch?.mergedAt
        ? 'This branch was merged. The resolution is in the original conversation.'
        : room.branch?.status === 'resolved'
          ? 'This branch is resolved. Reopen it to continue.'
          : 'This branch is archived.'
      : null;

  const socket = getSocket();
  const canvas = (
    <CanvasPanel
      roomId={room.id}
      readOnly={room.me.readOnly}
      focusBlockId={focusBlock}
      socket={socket}
      actor={{ id: me.id, name: me.displayName }}
      onJumpToMessage={(seq) => {
        setMobileView('stream');
        navigate(`/r/${room.id}?m=${seq}`);
      }}
    />
  );

  return (
    <div className="flex h-full min-w-0">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-1.5 border-b border-line px-2 py-1.5 sm:px-4">
          <IconButton label="Back to conversations" className="lg:hidden" onClick={() => navigate(room.parentRoomId ? `/r/${room.parentRoomId}` : '/')}>
            <ArrowLeft size={18} />
          </IconButton>
          <div className="min-w-0 flex-1">
            {room.kind === 'branch' && parent && (
              <Link to={`/r/${parent.id}`} className="flex items-center gap-1 text-xs text-ink-2 hover:text-ink hover:underline">
                <span className="truncate">{parent.name}</span>
                <ChevronRight size={12} className="shrink-0" />
              </Link>
            )}
            <button type="button" className="flex w-full min-w-0 items-center gap-2.5 text-left" onClick={() => setDialog('info')}>
              {room.kind !== 'branch' && <Avatar name={room.name} url={room.avatarUrl} size={34} online={otherOnline} />}
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 truncate font-semibold">
                  {room.kind === 'branch' && <GitBranch size={15} className="shrink-0 text-vein" />}
                  <span className="truncate">{room.name}</span>
                </span>
                {room.kind !== 'branch' && <span className="block truncate text-xs text-ink-2">{subtitle}</span>}
              </span>
            </button>
          </div>
          <div role="tablist" aria-label="View" className="flex rounded-lg bg-sunken p-0.5 lg:hidden">
            {(['stream', 'canvas'] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={mobileView === v} onClick={() => setMobileView(v)} className={cx('rounded-md px-2.5 py-1 text-xs font-medium capitalize transition', mobileView === v ? 'bg-surface text-ink shadow-card' : 'text-ink-2')}>
                {v}
              </button>
            ))}
          </div>
          <IconButton label="Conversation details" className="max-lg:hidden" onClick={() => setDialog('info')}>
            <Info size={18} />
          </IconButton>
          <IconButton label={canvasOpen ? 'Hide Canvas' : 'Show Canvas'} className="max-lg:hidden" onClick={() => setCanvasOpen(!canvasOpen)}>
            {canvasOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </IconButton>
        </header>

        {room.kind === 'branch' && room.branch && (
          <BranchBar room={room} onResolve={() => setDialog('resolve')} onMerge={() => setDialog('merge')} onGuests={() => setDialog('guests')} onAdd={() => setDialog('add')} />
        )}
        {connection === 'offline' && <p className="bg-copper-soft px-4 py-1 text-center text-xs text-copper">You're offline. Messages will send when you reconnect.</p>}

        {showCanvasInline && <div className="min-h-0 flex-1 bg-sheet">{canvas}</div>}
        <div className={cx('flex min-h-0 flex-1 flex-col', showCanvasInline && 'hidden')}>
          <Stream room={room} focusSeq={focusSeq} branches={branches} actions={actions} socket={socket} />
          <TypingIndicator roomId={room.id} />
          <Composer roomId={room.id} replyTo={replyTo} onClearReply={() => setReplyTo(null)} closedReason={closedReason} />
        </div>
      </main>

      {canvasOpen && isDesktop && (
        <aside aria-label="Canvas" className="flex w-[min(38%,460px)] shrink-0 flex-col border-l border-line bg-sheet">
          <header className="flex h-[51px] items-center gap-2 border-b border-line px-5">
            <h2 className="font-serif text-lg font-medium">Canvas</h2>
            <span className="truncate text-xs text-ink-2">what this conversation has settled</span>
          </header>
          <div className="min-h-0 flex-1">{canvas}</div>
        </aside>
      )}

      {branchFrom && (
        <CreateBranchDialog
          message={branchFrom}
          room={room}
          onClose={() => setBranchFrom(null)}
          onCreated={(id) => {
            setBranchFrom(null);
            navigate(`/r/${id}`);
          }}
        />
      )}
      {delivery && <DeliveryDialog message={delivery} onClose={() => setDelivery(null)} />}
      {refs && (
        <ReferencesDialog
          refs={refs}
          onClose={() => setRefs(null)}
          onCanvas={showBlock}
          onOpen={(r) => {
            setRefs(null);
            navigate(`/r/${r.roomId}`);
          }}
        />
      )}
      {dialog === 'resolve' && <ResolveDialog room={room} onClose={() => setDialog(null)} />}
      {dialog === 'merge' && <MergeDialog room={room} onClose={() => setDialog(null)} />}
      {dialog === 'guests' && <GuestDialog room={room} onClose={() => setDialog(null)} />}
      {dialog === 'add' && <AddParticipantsDialog room={room} parent={parent} onClose={() => setDialog(null)} />}
      {dialog === 'info' && <RoomInfoDialog room={room} branches={branches} onClose={() => setDialog(null)} />}
    </div>
  );
}
