import { GitBranch, LogOut, SendHorizontal } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import type {
  ApiErrorBody,
  CanvasDTO,
  GuestRedeemResponse,
  GuestRoomDTO,
  MediaUrlDTO,
  MessageDTO,
  MessagePage,
  SyncResponse,
} from '@strata/shared';
import { ApiError, CLIENT_HEADER, createClient } from '../../api/client';
import { Avatar, Button, EmptyState, Field, IconButton, Input, Pill, Segmented, Spinner, cx, timeLabel } from '../../components/ui';
import type { StrataSocket } from '../../realtime/socket';
import { mergeMessages } from '../../state/store';
import { BlockCard } from '../blocks/BlockCard';
import { rejoinAll } from '../blocks/blockSession';
import { CanvasPanel } from '../canvas/CanvasPanel';
import { MessageBody } from '../chat/MessageRow';
import { Wordmark } from '../shell/AppShell';

/** Guests get their own client: separate token, separate refresh cookie, and no route to the member API. */
function useGuestClient(onEnded: () => void) {
  return useMemo(() => createClient({ refreshPath: '/guest/token', lockName: 'strata-guest-refresh', onSignedOut: onEnded }), [onEnded]);
}

type Client = ReturnType<typeof createClient>;

function Join({ token, onJoined }: { token: string; onJoined: (res: GuestRedeemResponse) => void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [needsPin, setNeedsPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/guest/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, displayName: name.trim(), pin: pin || undefined }),
    }).catch(() => null);
    setBusy(false);
    if (!res) return setError('You appear to be offline');
    const body = (await res.json()) as GuestRedeemResponse & ApiErrorBody;
    if (res.ok) {
      // The link has done its job. Keeping the token out of the address bar stops it leaking through history or screenshots.
      history.replaceState(null, '', '/g');
      return onJoined(body);
    }
    if (body.error.code === 'GUEST_PIN_REQUIRED') setNeedsPin(true);
    setError(body.error.message);
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3.5">
        <Wordmark size={24} />
        <h1 className="text-[28px] leading-[34px] font-bold tracking-tight">You've been invited to a discussion</h1>
        <p className="text-sm text-ink-2">No account needed. You'll only see this one discussion, and your access ends when the link does.</p>
        <Field label="Your name" hint="Shown to everyone in the discussion.">
          <Input required value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        {needsPin && (
          <Field label="PIN">
            <Input required inputMode="numeric" value={pin} maxLength={8} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} autoFocus />
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-tint-alert px-3 py-2 text-sm text-alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()} className="h-10 w-full">
          Join discussion
        </Button>
      </form>
    </main>
  );
}

function Room({ client, guest, onEnded }: { client: Client; guest: GuestRedeemResponse['guest']; onEnded: (reason: string) => void }) {
  const [room, setRoom] = useState<GuestRoomDTO | null>(null);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [socket, setSocket] = useState<StrataSocket | null>(null);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState<string | null>(null);
  const [view, setView] = useState<'stream' | 'canvas'>('stream');
  const scroller = useRef<HTMLDivElement>(null);
  const revRef = useRef(0);

  const merge = useCallback((incoming: MessageDTO[]) => {
    revRef.current = incoming.reduce((max, m) => Math.max(max, m.rev), revRef.current);
    setMessages((current) => mergeMessages(current, incoming));
  }, []);

  useEffect(() => {
    client.request<{ room: GuestRoomDTO }>('/guest/room').then((r) => setRoom(r.room)).catch(() => onEnded('This discussion is no longer available.'));
    client.request<MessagePage>('/guest/messages').then((p) => merge(p.messages)).catch(() => {});

    let first = true;
    const s: StrataSocket = io({
      auth: (cb) => {
        void (async () => {
          if (!first) await client.refresh().catch(() => {});
          cb({ token: client.getToken() });
        })();
      },
      transports: ['websocket', 'polling'],
    });
    s.on('connect', () => {
      if (!first) {
        client.request<SyncResponse>('/guest/sync', { query: { sinceRev: revRef.current } }).then((r) => merge(r.messages)).catch(() => {});
        rejoinAll();
      }
      first = false;
    });
    s.on('message:new', ({ message }) => merge([message]));
    s.on('message:updated', ({ message }) => merge([message]));
    s.on('typing', (e) => setTyping(e.active ? e.name : null));
    s.on('branch:updated', ({ branch }) => setRoom((r) => (r && branch.status ? { ...r, status: branch.status } : r)));
    s.on('canvas:changed', (e) => window.dispatchEvent(new CustomEvent('strata:canvas', { detail: e })));
    s.on('session:revoked', () => onEnded('The person who invited you has ended this access.'));
    setSocket(s);
    return () => {
      s.removeAllListeners();
      s.disconnect();
    };
  }, [client, merge, onEnded]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const urlFor = useCallback((id: string) => client.request<MediaUrlDTO>(`/guest/media/${id}/url`), [client]);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    try {
      const { message } = await client.request<{ message: MessageDTO }>('/guest/messages', { method: 'POST', body: { clientMessageId: crypto.randomUUID(), text: body } });
      merge([message]);
    } catch (err) {
      setText(body);
      if (err instanceof ApiError && err.status === 401) onEnded('Your access has ended.');
    }
  };

  const leave = async () => {
    await client.request('/guest/leave', { method: 'POST' }).catch(() => {});
    onEnded('You left the discussion.');
  };

  if (!room) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const open = room.status === 'open';
  const actor = { id: guest.id, name: guest.displayName };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2 sm:px-5">
        <GitBranch size={16} className="shrink-0 text-branch" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{room.title}</h1>
          <p className="truncate text-xs text-ink-2">
            {room.participants.map((p) => p.name).join(', ')} · access ends {new Date(room.expiresAt).toLocaleDateString()}
          </p>
        </div>
        <Pill tone="crystal">Guest</Pill>
        {room.scope.canvas && (
          <Segmented role="tablist" label="View" value={view} onChange={setView} options={[['stream', 'stream'], ['canvas', 'canvas']]} />
        )}
        <IconButton label="Leave discussion" onClick={leave}>
          <LogOut size={17} />
        </IconButton>
      </header>

      {view === 'canvas' ? (
        <div className="min-h-0 flex-1 bg-sheet">
          <CanvasPanel roomId="guest" readOnly focusBlockId={null} socket={socket} actor={actor} load={() => client.request<{ canvas: CanvasDTO }>('/guest/canvas').then((r) => r.canvas)} />
        </div>
      ) : (
        <>
          <div ref={scroller} role="log" aria-label="Messages" className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-5">
            {messages.length === 0 && <EmptyState title="Nothing here yet">Say hello.</EmptyState>}
            {messages.map((m) =>
              m.payload.type === 'system' ? (
                <p key={m.id} className="my-2 text-center text-xs text-ink-3">
                  {m.payload.text}
                </p>
              ) : (
                <article key={m.id} className={cx('mt-3 flex items-end gap-2', m.sender.id === guest.id && 'flex-row-reverse')}>
                  {m.sender.id !== guest.id && <Avatar name={m.sender.name} size={32} />}
                  <div className={cx('min-w-0', m.payload.type === 'block' ? 'w-full max-w-md' : 'max-w-[82%]')}>
                    <div className={cx(m.payload.type !== 'block' && 'rounded-[18px] px-3.5 py-2', m.payload.type !== 'block' && (m.sender.id === guest.id ? 'st-bubble-mine rounded-br-md bg-bubble-mine text-on-bubble-mine' : 'rounded-bl-md border border-line bg-surface'))}>
                      {m.sender.id !== guest.id && (
                        <header className="flex items-center gap-2">
                          <span className="text-xs font-bold text-ink-2">{m.sender.name}</span>
                          {m.sender.type === 'guest' && <Pill tone="crystal">Guest</Pill>}
                          <time className="font-mono text-[11px] text-ink-3">{timeLabel(m.createdAt)}</time>
                        </header>
                      )}
                      <MessageBody
                        m={m}
                        urlFor={urlFor}
                        renderBlock={(p) => <BlockCard blockId={p.blockId} type={p.blockType} fallbackTitle={p.title} socket={socket} actor={actor} history={false} />}
                      />
                    </div>
                  </div>
                </article>
              ),
            )}
          </div>
          <p aria-live="polite" className="h-5 px-5 text-xs text-ink-2">
            {typing ? `${typing} is typing` : ''}
          </p>
          {room.scope.write && open ? (
            <form onSubmit={send} className="flex items-center gap-1 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
              <div className="st-glass flex flex-1 items-center gap-1 rounded-[20px] p-1 shadow-float">
                <input
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    socket?.emit('typing', { roomId: messages[0]?.roomId ?? '', active: e.target.value.length > 0 });
                  }}
                  aria-label="Message"
                  placeholder="Write a message"
                  className="min-w-0 flex-1 bg-transparent px-2 py-1.5 outline-none placeholder:text-ink-3"
                />
                <IconButton type="submit" label="Send" disabled={!text.trim()} className={cx(text.trim() && 'st-primary st-pop hover:text-on-violet')}>
                  <SendHorizontal size={17} className="i-nudge" />
                </IconButton>
              </div>
            </form>
          ) : (
            <p className="border-t border-line px-4 py-3 text-center text-sm text-ink-2">{open ? 'You can read this discussion but not reply.' : 'This discussion is closed.'}</p>
          )}
        </>
      )}
    </div>
  );
}

function Ended({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <EmptyState title="Access ended">{message}</EmptyState>
    </div>
  );
}

export function GuestPage() {
  const token = useMemo(() => new URLSearchParams(location.hash.slice(1)).get('t'), []);
  const [ended, setEnded] = useState<string | null>(null);
  const [guest, setGuest] = useState<GuestRedeemResponse['guest'] | null>(null);
  const [checking, setChecking] = useState(!token);

  const onSignedOut = useCallback(() => setEnded('Your access has ended.'), []);
  const client = useGuestClient(onSignedOut);

  useEffect(() => {
    if (token) return;
    // A reload after joining: the guest cookie brings the session back.
    fetch('/api/guest/token', { method: 'POST', headers: CLIENT_HEADER })
      .then(async (res) => {
        if (!res.ok) return setEnded('This link is not valid. Ask for a new one.');
        const body = (await res.json()) as GuestRedeemResponse;
        client.setToken(body.accessToken);
        setGuest(body.guest);
      })
      .catch(() => setEnded('You appear to be offline'))
      .finally(() => setChecking(false));
  }, [client, token]);

  if (ended) return <Ended message={ended} />;
  if (checking) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!guest && token) {
    return (
      <Join
        token={token}
        onJoined={(res) => {
          client.setToken(res.accessToken);
          setGuest(res.guest);
        }}
      />
    );
  }
  return guest ? <Room client={client} guest={guest} onEnded={setEnded} /> : <Ended message="This link is not valid. Ask for a new one." />;
}
