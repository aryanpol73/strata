import { BellOff, GitBranch, Search, UserMinus, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { payloadExcerpt, type BranchSummaryDTO, type RoomDTO, type SearchHit, type UserDTO } from '@strata/shared';
import { api } from '../../api/client';
import { Avatar, Button, Dialog, Field, Input, Pill, cx, shortTime } from '../../components/ui';
import { loadRoom, loadRooms, startDirect, startGroup } from '../../state/actions';
import { toast, toastError, useStore } from '../../state/store';

function usePeopleSearch(query: string) {
  const [people, setPeople] = useState<UserDTO[]>([]);
  useEffect(() => {
    const q = query.trim().replace(/^@/, '');
    if (q.length < 2) {
      setPeople([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ users: UserDTO[] }>('/users/search', { query: { q } })
        .then((r) => setPeople(r.users))
        .catch(toastError);
    }, 180);
    return () => clearTimeout(timer);
  }, [query]);
  return people;
}

export function NewConversationDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'direct' | 'group'>('direct');
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<UserDTO[]>([]);
  const people = usePeopleSearch(query);

  const openDirect = async (user: UserDTO) => {
    try {
      const room = await startDirect(user.id);
      onClose();
      navigate(`/r/${room.id}`);
    } catch (err) {
      toastError(err);
    }
  };

  const createGroup = async () => {
    try {
      const room = await startGroup(name.trim(), chosen.map((c) => c.id));
      onClose();
      navigate(`/r/${room.id}`);
    } catch (err) {
      toastError(err);
    }
  };

  const pick = (user: UserDTO) => {
    if (mode === 'direct') return void openDirect(user);
    setChosen((c) => (c.some((x) => x.id === user.id) ? c : [...c, user]));
    setQuery('');
  };

  return (
    <Dialog
      title="New conversation"
      onClose={onClose}
      footer={
        mode === 'group' ? (
          <Button variant="primary" disabled={!name.trim()} onClick={createGroup}>
            Create group
          </Button>
        ) : undefined
      }
    >
      <div className="mb-3 flex rounded-lg bg-tint-plain p-0.5">
        {(['direct', 'group'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} className={cx('flex-1 rounded-md py-1.5 text-sm font-medium transition', mode === m ? 'bg-surface shadow-card' : 'text-ink-2')}>
            {m === 'direct' ? 'One person' : 'A group'}
          </button>
        ))}
      </div>
      {mode === 'group' && (
        <div className="mb-3">
          <Field label="Group name">
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
      )}
      <Field label="Find people by handle">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="@handle" autoComplete="off" />
      </Field>
      {chosen.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chosen.map((c) => (
            <button key={c.id} type="button" aria-label={`Remove ${c.displayName}`} onClick={() => setChosen((all) => all.filter((x) => x.id !== c.id))}>
              <Pill tone="branch">{c.displayName} ×</Pill>
            </button>
          ))}
        </div>
      )}
      <ul className="mt-2">
        {people.map((p) => (
          <li key={p.id}>
            <button type="button" onClick={() => pick(p)} className="flex w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left st-press hover:bg-tint-plain">
              <Avatar name={p.displayName} url={p.avatarUrl} size={32} />
              <span>
                <span className="block text-sm font-medium">{p.displayName}</span>
                <span className="block text-xs text-ink-2">@{p.handle}</span>
              </span>
            </button>
          </li>
        ))}
        {query.trim().length >= 2 && people.length === 0 && <li className="px-1 py-2 text-sm text-ink-3">Nobody by that handle.</li>}
      </ul>
    </Dialog>
  );
}

export function SearchDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (query.trim().length < 2) {
      setHits(null);
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api<{ hits: SearchHit[] }>('/search', { query: { q: query.trim() } })
        .then((r) => mine === seq.current && setHits(r.hits))
        .catch(toastError);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <Dialog title="Search" onClose={onClose}>
      <div className="relative">
        <Search size={16} className="absolute top-3 left-3 text-ink-3" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your conversations" aria-label="Search" className="pl-9" />
      </div>
      <ul className="mt-2">
        {hits?.map((h) => (
          <li key={h.message.id}>
            <button
              type="button"
              onClick={() => {
                onClose();
                navigate(`/r/${h.message.roomId}?m=${h.message.seq}`);
              }}
              className="w-full rounded-lg px-2 py-2 text-left st-press hover:bg-tint-plain"
            >
              <span className="flex items-center gap-1.5 text-xs text-ink-2">
                {h.roomKind === 'branch' && <GitBranch size={12} className="text-branch" />}
                {h.roomName} · {h.message.sender.name} · {shortTime(h.message.createdAt)}
              </span>
              <span className="line-clamp-2 block text-sm">{payloadExcerpt(h.message.payload, 200)}</span>
            </button>
          </li>
        ))}
        {hits?.length === 0 && <li className="px-2 py-3 text-sm text-ink-3">No messages match that.</li>}
      </ul>
    </Dialog>
  );
}

const MUTES = [
  { label: '1 hour', hours: 1 },
  { label: '8 hours', hours: 8 },
  { label: '1 week', hours: 168 },
];

export function RoomInfoDialog({ room, branches, onClose }: { room: RoomDTO; branches: BranchSummaryDTO[]; onClose: () => void }) {
  const navigate = useNavigate();
  const me = useStore((s) => s.me)!;
  const online = useStore((s) => s.online);
  const [query, setQuery] = useState('');
  const [name, setName] = useState(room.name);
  const people = usePeopleSearch(query);
  const admin = room.me.role === 'owner' || room.me.role === 'admin';
  const owner = room.me.role === 'owner';
  const muted = !!room.me.mutedUntil && new Date(room.me.mutedUntil) > new Date();

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await loadRoom(room.id);
    } catch (err) {
      toastError(err);
    }
  };

  const mute = (until: Date | null) =>
    run(async () => {
      await api(`/rooms/${room.id}/mute`, { method: 'PATCH', body: { until: until?.toISOString() ?? null } });
      toast(until ? 'Muted' : 'Unmuted');
    });

  const leave = async () => {
    if (!confirm('Leave this conversation? You will also leave its branches.')) return;
    try {
      await api(`/rooms/${room.id}/members/${me.id}`, { method: 'DELETE' });
      await loadRooms();
      onClose();
      navigate('/');
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <Dialog title={room.name} onClose={onClose}>
      {room.kind === 'group' && admin && (
        <form
          className="mb-4 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name !== room.name) void run(() => api(`/rooms/${room.id}`, { method: 'PATCH', body: { name: name.trim() } }));
          }}
        >
          <div className="flex-1">
            <Field label="Name">
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Button type="submit">Rename</Button>
        </form>
      )}

      {!room.me.readOnly && (
        <section className="mb-4">
          <h3 className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
            <BellOff size={14} /> Notifications
          </h3>
          {muted ? (
            <Button className="h-8" onClick={() => mute(null)}>
              Unmute (until {shortTime(room.me.mutedUntil!)})
            </Button>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {MUTES.map((m) => (
                <Button key={m.hours} className="h-8" onClick={() => mute(new Date(Date.now() + m.hours * 3_600_000))}>
                  Mute {m.label}
                </Button>
              ))}
            </div>
          )}
        </section>
      )}

      {room.kind === 'group' && admin && (
        <section className="mb-4">
          <h3 className="mb-1 text-[13px] font-medium text-ink-2">Who can require acknowledgement?</h3>
          <div className="flex gap-1.5">
            {(['members', 'admins'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={room.settings.blockingAck === v}
                onClick={() => run(() => api(`/rooms/${room.id}`, { method: 'PATCH', body: { blockingAck: v } }))}
                className={cx('rounded-lg border px-2.5 py-1 text-sm capitalize transition', room.settings.blockingAck === v ? 'border-violet bg-tint-violet' : 'border-line hover:border-line-strong')}
              >
                {v === 'members' ? 'Everyone' : 'Admins only'}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mb-4">
        <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
          <Users size={14} /> {room.members.length} {room.members.length === 1 ? 'person' : 'people'}
        </h3>
        <ul>
          {room.members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2.5 py-1.5">
              <Avatar name={m.displayName} url={m.avatarUrl} size={30} online={!!online[m.userId]} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {m.displayName} {m.userId === me.id && <span className="font-normal text-ink-3">(you)</span>}
                </span>
                <span className="block truncate text-xs text-ink-2">@{m.handle}</span>
              </span>
              {m.role !== 'member' && <Pill tone="plain">{m.role}</Pill>}
              {owner && room.kind === 'group' && m.userId !== me.id && (
                <Button className="h-7 px-2 text-xs" onClick={() => run(() => api(`/rooms/${room.id}/members/${m.userId}`, { method: 'PATCH', body: { role: m.role === 'admin' ? 'member' : 'admin' } }))}>
                  {m.role === 'admin' ? 'Remove admin' : 'Make admin'}
                </Button>
              )}
              {admin && room.kind === 'group' && m.userId !== me.id && m.role !== 'owner' && (
                <button type="button" aria-label={`Remove ${m.displayName}`} title="Remove" onClick={() => run(() => api(`/rooms/${room.id}/members/${m.userId}`, { method: 'DELETE' }))} className="rounded p-1 text-ink-3 transition hover:text-alert">
                  <UserMinus size={15} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {room.kind === 'group' && admin && (
          <div className="mt-2">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add someone by @handle" aria-label="Add someone" autoComplete="off" />
            <ul>
              {people
                .filter((p) => !room.members.some((m) => m.userId === p.id))
                .map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery('');
                        void run(() => api(`/rooms/${room.id}/members`, { method: 'POST', body: { userIds: [p.id] } }));
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-1 py-1.5 text-left text-sm st-press hover:bg-tint-plain"
                    >
                      <Avatar name={p.displayName} url={p.avatarUrl} size={26} /> {p.displayName}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </section>

      {branches.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
            <GitBranch size={14} /> Branches
          </h3>
          <ul>
            {branches.map((b) => (
              <li key={b.roomId}>
                <button
                  type="button"
                  disabled={!b.canReadTranscript}
                  onClick={() => {
                    onClose();
                    navigate(`/r/${b.roomId}`);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm transition enabled:hover:bg-tint-plain"
                >
                  <span className="min-w-0 flex-1 truncate">{b.title}</span>
                  <Pill tone={b.status === 'open' ? 'branch' : 'crystal'}>{b.mergedAt ? 'Merged' : b.status}</Pill>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {room.kind === 'group' && (
        <Button className="hover:border-alert hover:text-alert" onClick={leave}>
          Leave group
        </Button>
      )}
    </Dialog>
  );
}

