import { GitBranch } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, Pill, cx, shortTime } from '../../components/ui';
import { useStore } from '../../state/store';

const TABS = [
  ['open', 'Open'],
  ['resolved', 'Resolved'],
  ['merged', 'Merged'],
] as const;

type Tab = (typeof TABS)[number][0];

export function BranchesPage() {
  const rooms = useStore((s) => s.rooms);
  const [tab, setTab] = useState<Tab>('open');

  const branches = useMemo(
    () =>
      Object.values(rooms)
        .filter((r) => r.kind === 'branch' && r.me.role)
        .filter((r) => {
          if (tab === 'merged') return !!r.branch?.mergedAt;
          return !r.branch?.mergedAt && r.branch?.status === tab;
        })
        .sort((a, b) => (b.lastMessage?.at ?? b.updatedAt).localeCompare(a.lastMessage?.at ?? a.updatedAt)),
    [rooms, tab],
  );

  return (
    <div className="scroll-thin h-full overflow-y-auto px-4 pt-3 pb-28 lg:px-8 lg:pb-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-3 text-2xl font-bold tracking-tight">Branches</h1>
        <div className="mb-4 flex gap-2">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)} className={cx('st-press rounded-full px-3 py-1.5 text-[13px] font-semibold', tab === id ? 'st-primary' : 'border border-line text-ink-2 hover:border-line-strong')}>
              {label}
            </button>
          ))}
        </div>
        {branches.length === 0 ? (
          <EmptyState title={`No ${tab} branches`}>Branch from any message to take a topic somewhere focused.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {branches.map((room) => {
              const parent = room.parentRoomId ? rooms[room.parentRoomId] : undefined;
              return (
                <li key={room.id}>
                  <Link to={`/r/${room.id}`} className="st-press block rounded-2xl border border-line bg-surface p-3 hover:border-line-strong">
                    <span className="flex items-center gap-2">
                      <GitBranch size={16} className="shrink-0 text-branch" />
                      <span className="min-w-0 flex-1 truncate font-semibold">{room.name}</span>
                      {room.lastMessage && <span className="font-mono text-[11px] text-ink-3">{shortTime(room.lastMessage.at)}</span>}
                      <Pill tone={tab === 'open' ? 'branch' : 'crystal'}>{TABS.find(([id]) => id === tab)![1]}</Pill>
                    </span>
                    <span className="mt-0.5 block truncate text-[13px] text-ink-2">
                      {parent ? `${parent.name}, ` : ''}
                      {room.members.length} {room.members.length === 1 ? 'person' : 'people'}
                    </span>
                    {room.lastMessage && <span className="mt-1.5 block truncate text-[13px] text-ink-2">{room.lastMessage.text}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
