import { Check, History, Lock, Plus, Trash2, UserPlus, Users, WifiOff, X } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as Y from 'yjs';
import {
  BLOCK_REGISTRY,
  checklistOps,
  infoCardOps,
  rosterOps,
  type BlockActivityDTO,
  type ChecklistSummary,
  type InfoCardSummary,
  type RosterSummary,
} from '@strata/shared';
import { api } from '../../api/client';
import { Dialog, IconButton, Pill, Spinner, cx, shortTime } from '../../components/ui';
import type { StrataSocket } from '../../realtime/socket';
import { toastError } from '../../state/store';
import { acquireSession, releaseSession, type BlockSession } from './blockSession';

export interface BlockActor {
  id: string;
  name: string;
}

function useBlockSession(blockId: string, socket: StrataSocket | null) {
  const [session, setSession] = useState<BlockSession | null>(null);
  useEffect(() => {
    if (!socket) return;
    const s = acquireSession(blockId, socket);
    setSession(s);
    return () => {
      releaseSession(s);
      setSession(null);
    };
  }, [blockId, socket]);

  const version = useSyncExternalStore(
    (fn) => (session ? (session.subscribe(fn) as () => void) : () => {}),
    () => (session ? `${session.status}:${session.canEdit}:${Y.encodeStateVector(session.doc).join()}` : ''),
  );
  return { session, version };
}

/** Applies a text edit as the smallest splice, so concurrent edits elsewhere in the string survive it. */
function spliceText(text: Y.Text, next: string) {
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start += 1;
  let end = 0;
  while (end < prev.length - start && end < next.length - start && prev[prev.length - 1 - end] === next[next.length - 1 - end]) end += 1;
  text.doc?.transact(() => {
    if (prev.length - start - end > 0) text.delete(start, prev.length - start - end);
    if (next.length - start - end > 0) text.insert(start, next.slice(start, next.length - end));
  });
}

function ChecklistBody({ session, summary, actor }: { session: BlockSession; summary: ChecklistSummary; actor: BlockActor }) {
  const [draft, setDraft] = useState('');
  const { doc, canEdit } = session;
  const add = () => {
    if (!draft.trim()) return;
    checklistOps.add(doc, draft.trim());
    setDraft('');
  };
  return (
    <div>
      <ul className="divide-y divide-line/60">
        {summary.items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2.5 py-1.5">
            <button
              type="button"
              role="checkbox"
              aria-checked={item.done}
              aria-label={`Mark "${item.text}" ${item.done ? 'not done' : 'done'}`}
              disabled={!canEdit}
              onClick={() => checklistOps.toggle(doc, item.id, actor.name)}
              className={cx(
                'flex size-5 shrink-0 items-center justify-center rounded-md border transition',
                item.done ? 'border-violet-fill bg-violet-fill text-on-violet' : 'border-line-strong hover:border-branch',
              )}
            >
              {item.done && <Check size={14} strokeWidth={3} />}
            </button>
            <input
              value={item.text}
              readOnly={!canEdit}
              aria-label="Item text"
              onChange={(e) => {
                const text = checklistOps.text(doc, item.id);
                if (text) spliceText(text, e.target.value);
              }}
              className={cx('min-w-0 flex-1 bg-transparent text-sm outline-none', item.done && 'text-ink-3 line-through')}
            />
            {item.done && item.doneBy && <span className="hidden shrink-0 text-xs text-ink-3 sm:inline">{item.doneBy}</span>}
            {canEdit && (
              <button type="button" aria-label={`Remove "${item.text}"`} onClick={() => checklistOps.remove(doc, item.id)} className="text-ink-3 opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:text-alert max-sm:opacity-100">
                <X size={15} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form
          className="mt-1.5 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Plus size={16} className="ml-0.5 text-ink-3" />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add an item" aria-label="New item" className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-ink-3" />
        </form>
      )}
    </div>
  );
}

function RosterBody({ session, summary, actor }: { session: BlockSession; summary: RosterSummary; actor: BlockActor }) {
  const { doc, canEdit } = session;
  return (
    <ul className="space-y-2.5">
      {summary.slots.map((slot) => {
        const mine = [...slot.confirmed, ...slot.waitlist].some((c) => c.principalId === actor.id);
        const full = slot.confirmed.length >= slot.capacity;
        return (
          <li key={slot.id}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{slot.label}</span>
              <span className="font-mono text-xs text-ink-3">
                {slot.confirmed.length}/{slot.capacity}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {slot.confirmed.map((c) => (
                <Pill key={c.key} tone="branch">
                  {c.name}
                </Pill>
              ))}
              {slot.waitlist.map((c) => (
                <Pill key={c.key} tone="plain">
                  {c.name} · waiting
                </Pill>
              ))}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => (mine ? rosterOps.release(doc, slot.id, actor.id) : rosterOps.claim(doc, slot.id, actor))}
                  className={cx(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition',
                    mine ? 'border-line text-ink-2 hover:border-alert hover:text-alert' : 'border-branch text-branch hover:bg-tint-branch',
                  )}
                >
                  {mine ? <X size={12} /> : <UserPlus size={12} />}
                  {mine ? 'Withdraw' : full ? 'Join waitlist' : 'Sign up'}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function InfoBody({ session, summary }: { session: BlockSession; summary: InfoCardSummary }) {
  const { doc, canEdit } = session;
  const [label, setLabel] = useState('');
  return (
    <div>
      <dl className="space-y-2">
        {summary.fields.map((field) => (
          <div key={field.id} className="group">
            <dt className="flex items-center justify-between text-xs font-medium text-ink-3">
              <span>{field.label}</span>
              {canEdit && (
                <button type="button" aria-label={`Remove ${field.label}`} onClick={() => infoCardOps.remove(doc, field.id)} className="opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:text-alert max-sm:opacity-100">
                  <Trash2 size={13} />
                </button>
              )}
            </dt>
            <dd>
              <input
                value={field.value}
                readOnly={!canEdit}
                aria-label={field.label}
                placeholder={canEdit ? 'Empty' : ''}
                onChange={(e) => {
                  const text = infoCardOps.value(doc, field.id);
                  if (text) spliceText(text, e.target.value);
                }}
                className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
              />
            </dd>
          </div>
        ))}
      </dl>
      {canEdit && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return;
            infoCardOps.add(doc, label.trim());
            setLabel('');
          }}
        >
          <Plus size={16} className="ml-0.5 text-ink-3" />
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a field" aria-label="New field" className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-ink-3" />
        </form>
      )}
    </div>
  );
}

function HistoryDialog({ blockId, onClose }: { blockId: string; onClose: () => void }) {
  const [rows, setRows] = useState<BlockActivityDTO[] | null>(null);
  useEffect(() => {
    api<{ activity: BlockActivityDTO[] }>(`/blocks/${blockId}/activity`)
      .then((r) => setRows(r.activity))
      .catch(toastError);
  }, [blockId]);
  return (
    <Dialog title="Change history" onClose={onClose}>
      {!rows ? (
        <Spinner />
      ) : (
        <ol className="space-y-2.5">
          {rows.map((row) => (
            <li key={row.id} className="text-sm">
              <span className="font-medium">{row.actorName}</span> <span className="text-ink-2">{row.action}</span> {row.detail}
              <span className="ml-2 font-mono text-xs text-ink-3">{shortTime(row.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

const ICONS: Record<string, ReactNode> = {
  checklist: <Check size={14} />,
  roster: <Users size={14} />,
};

export function BlockCard({
  blockId,
  type,
  fallbackTitle,
  socket,
  actor,
  history = true,
}: {
  blockId: string;
  type: string;
  fallbackTitle: string;
  socket: StrataSocket | null;
  actor: BlockActor;
  history?: boolean;
}) {
  const { session, version } = useBlockSession(blockId, socket);
  const [showHistory, setShowHistory] = useState(false);
  const def = BLOCK_REGISTRY[type];

  const summary = useMemo(() => {
    if (!session || !def || session.status === 'joining') return null;
    return def.summarize(session.doc);
    // `version` changes whenever the document does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, def, version]);

  if (!def) return null;
  const status = session?.status ?? 'joining';

  return (
    <section aria-label={`${def.label}: ${summary?.title ?? fallbackTitle}`} className="mt-1 max-w-md rounded-2xl border border-line-strong bg-raised p-3">
      <header className="mb-2 flex items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-md bg-tint-branch text-branch">{ICONS[type] ?? <Lock size={14} />}</span>
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold">{summary?.title || fallbackTitle}</h4>
        {type === 'checklist' && summary && (
          <span className="font-mono text-xs text-ink-3">
            {(summary as ChecklistSummary).doneCount}/{(summary as ChecklistSummary).items.length}
          </span>
        )}
        {status === 'offline' && <WifiOff size={14} className="text-ink-3" aria-label="Offline: your changes will sync" />}
        {history && (
          <IconButton label="Change history" className="size-7" onClick={() => setShowHistory(true)}>
            <History size={14} />
          </IconButton>
        )}
      </header>
      {status === 'denied' && <p className="text-sm text-ink-3">This block isn't available to you.</p>}
      {status === 'joining' && <Spinner />}
      {session && summary && status !== 'denied' && (
        <>
          {type === 'checklist' && <ChecklistBody session={session} summary={summary as ChecklistSummary} actor={actor} />}
          {type === 'roster' && <RosterBody session={session} summary={summary as RosterSummary} actor={actor} />}
          {type === 'info' && <InfoBody session={session} summary={summary as InfoCardSummary} />}
          {session.error && <p className="mt-1.5 text-xs text-alert">{session.error}</p>}
          {!session.canEdit && status === 'live' && <p className="mt-1.5 text-xs text-ink-3">View only</p>}
        </>
      )}
      {showHistory && <HistoryDialog blockId={blockId} onClose={() => setShowHistory(false)} />}
    </section>
  );
}
