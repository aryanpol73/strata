import {
  BellRing,
  Bookmark,
  CheckCheck,
  Clock,
  CornerUpLeft,
  FileText,
  GitBranch,
  Layers,
  MoreHorizontal,
  Pencil,
  Radio,
  Smile,
  Trash2,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { BranchSummaryDTO, MediaUrlDTO, MessageDTO } from '@strata/shared';
import { Avatar, Button, Dialog, IconButton, Pill, Textarea, cx, timeLabel } from '../../components/ui';

export interface RowActions {
  onReply(m: MessageDTO): void;
  onBranch(m: MessageDTO): void;
  onCanvas(m: MessageDTO): void;
  onReact(m: MessageDTO, emoji: string): void;
  onEdit(m: MessageDTO, text: string): void;
  onDelete(m: MessageDTO): void;
  onDelivery(m: MessageDTO): void;
  onAck(m: MessageDTO): void;
  onOpenBranch(roomId: string): void;
  onShowRefs(m: MessageDTO): void;
}

const QUICK = ['👍', '✅', '🎉', '👀', '❤️'];

function linkify(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s<]+)/g).map((part, i) =>
    i % 2 ? (
      <a key={i} href={part} target="_blank" rel="noreferrer noopener" className="text-branch underline underline-offset-2">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

export function MediaBody({ payload, urlFor }: { payload: Extract<MessageDTO['payload'], { type: 'media' }>; urlFor: (id: string) => Promise<MediaUrlDTO> }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const image = payload.mime.startsWith('image/');

  useEffect(() => {
    if (!image) return;
    let live = true;
    urlFor(payload.assetId)
      .then((r) => live && setUrl(r.url))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [image, payload.assetId, urlFor]);

  const download = async () => {
    const { url: link } = await urlFor(payload.assetId);
    window.open(link, '_blank', 'noopener');
  };

  return (
    <div className="mt-1">
      {image && !failed ? (
        <div className="max-w-sm overflow-hidden rounded-lg border border-line bg-tint-plain" style={{ aspectRatio: payload.width && payload.height ? `${payload.width}/${payload.height}` : undefined }}>
          {url && <img src={url} alt={payload.caption || payload.name} className="size-full object-contain" loading="lazy" />}
        </div>
      ) : (
        <button type="button" onClick={download} className="flex max-w-sm items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left transition hover:border-line-strong">
          <FileText size={18} className="text-ink-2" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{payload.name}</span>
            <span className="block text-xs text-ink-3">{(payload.bytes / 1024).toFixed(0)} KB</span>
          </span>
        </button>
      )}
      {payload.caption && <p className="mt-1 whitespace-pre-wrap">{payload.caption}</p>}
    </div>
  );
}

/** The moment a side discussion becomes knowledge: it should look settled, not like a chat message. */
function ResolutionCard({ m, actions, canOpen }: { m: MessageDTO; actions: RowActions; canOpen: boolean }) {
  if (m.payload.type !== 'resolution') return null;
  const p = m.payload;
  return (
    <div className="my-2 rounded-2xl border border-crystal-line bg-tint-crystal p-3.5">
      <div className="layer-rule mb-2.5 w-28" />
      <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.08em] text-crystal uppercase">
        <GitBranch size={13} /> Resolved in branch
      </p>
      <h4 className="mt-1 text-[17px] leading-snug font-bold">{p.branchTitle}</h4>
      <p className="mt-1 whitespace-pre-wrap font-serif text-[17px] leading-[25px]">{p.summary}</p>
      <p className="mt-2 text-xs text-ink-2">
        {p.resolvedBy} · {p.participantCount} {p.participantCount === 1 ? 'person' : 'people'} · {timeLabel(m.createdAt)}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {(canOpen || p.transcriptOpen) && (
          <Button className="h-8" onClick={() => actions.onOpenBranch(p.branchRoomId)}>
            <GitBranch size={14} /> {canOpen ? 'Open branch' : 'Read transcript'}
          </Button>
        )}
        {m.refCount > 0 ? (
          <Button className="h-8 text-crystal" onClick={() => actions.onShowRefs(m)}>
            <Bookmark size={14} /> On Canvas
          </Button>
        ) : (
          <Button className="h-8" onClick={() => actions.onCanvas(m)}>
            <Bookmark size={14} /> Add to Canvas
          </Button>
        )}
      </div>
    </div>
  );
}

function AckBar({ m, meId, actions }: { m: MessageDTO; meId: string; actions: RowActions }) {
  if (!m.ack) return null;
  const { deadline, state, requiredIds, ackedIds } = m.ack;
  const mustAck = requiredIds.includes(meId) && !ackedIds.includes(meId);
  const when = new Date(deadline).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="mt-1.5 flex max-w-md flex-wrap items-center gap-2 rounded-xl bg-tint-alert px-2.5 py-1.5 text-sm">
      <BellRing size={14} className="text-alert" />
      <span className="min-w-0 flex-1 text-ink-2">
        {state === 'satisfied' && 'Everyone acknowledged'}
        {state === 'open' && `${ackedIds.length} of ${requiredIds.length} acknowledged · by ${when}`}
        {state === 'expired' && `Deadline passed · ${ackedIds.length} of ${requiredIds.length}`}
      </span>
      {mustAck && (
        <Button variant="danger" className="h-7 px-2.5 text-xs" onClick={() => actions.onAck(m)}>
          Acknowledge
        </Button>
      )}
    </div>
  );
}

function BranchStem({ branches, actions }: { branches: BranchSummaryDTO[]; actions: RowActions }) {
  return (
    <div className="mt-1 space-y-0.5">
      {branches.map((b) => (
        <button
          key={b.roomId}
          type="button"
          disabled={!b.canReadTranscript}
          onClick={() => actions.onOpenBranch(b.roomId)}
          className="st-press group flex items-center gap-1.5 rounded-lg px-1 text-left text-sm disabled:cursor-default"
        >
          <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden className="text-branch">
            <path d="M2 0v6c0 4 3 6 7 6h8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className={cx('font-medium text-branch', b.canReadTranscript && 'group-hover:underline')}>{b.title}</span>
          <Pill tone={b.status === 'open' ? 'branch' : b.status === 'resolved' ? 'crystal' : 'plain'}>{b.mergedAt ? 'Merged' : b.status}</Pill>
          <span className="text-xs text-ink-3">
            {b.participantCount} {b.participantCount === 1 ? 'person' : 'people'}
            {!b.isParticipant && ' · not in this branch'}
          </span>
        </button>
      ))}
    </div>
  );
}

export function MessageBody({
  m,
  urlFor,
  renderBlock,
}: {
  m: MessageDTO;
  urlFor: (id: string) => Promise<MediaUrlDTO>;
  renderBlock: (p: Extract<MessageDTO['payload'], { type: 'block' }>) => ReactNode;
}) {
  switch (m.payload.type) {
    case 'text':
      return <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{linkify(m.payload.text)}</p>;
    case 'media':
      return <MediaBody payload={m.payload} urlFor={urlFor} />;
    case 'block':
      return <>{renderBlock(m.payload)}</>;
    case 'deleted':
      return <p className="text-sm text-ink-3 italic">Message deleted</p>;
    default:
      return null;
  }
}

const POSTURE_TAG = {
  whisper: { tone: 'whisper', icon: <Radio size={11} />, label: 'Whisper' },
  digest: { tone: 'crystal', icon: <Layers size={11} />, label: 'Digest' },
} as const;

export function MessageRow({
  m,
  compact,
  meId,
  mine,
  isAdmin,
  branches,
  actions,
  body,
  readOnly,
  highlighted,
  canOpenResolution,
  receipt,
  showName,
}: {
  m: MessageDTO;
  compact: boolean;
  meId: string;
  mine: boolean;
  isAdmin: boolean;
  branches: BranchSummaryDTO[];
  actions: RowActions;
  body: ReactNode;
  readOnly: boolean;
  highlighted: boolean;
  canOpenResolution: boolean;
  receipt: string | null;
  showName: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sheet, setSheet] = useState(false);
  const [picker, setPicker] = useState(false);

  if (m.payload.type === 'system') {
    return <p className="my-2 text-center text-xs text-ink-3">{m.payload.text}</p>;
  }

  const deleted = !!m.deletedAt;
  const canEdit = mine && m.payload.type === 'text' && !deleted && !readOnly;
  const canDelete = (mine || isAdmin) && !deleted && !readOnly;
  const posture = m.posture === 'whisper' || m.posture === 'digest' ? POSTURE_TAG[m.posture] : null;

  const startEdit = () => {
    if (m.payload.type !== 'text') return;
    setDraft(m.payload.text);
    setEditing(true);
  };

  type MenuItem = { label: string; icon: ReactNode; run: () => void; danger?: boolean };
  const candidates: (MenuItem | false)[] = [
    !readOnly && !deleted && { label: 'Reply', icon: <CornerUpLeft size={16} />, run: () => actions.onReply(m) },
    !readOnly && !deleted && { label: 'Branch from here', icon: <GitBranch size={16} />, run: () => actions.onBranch(m) },
    !readOnly && !deleted && { label: 'Add to Canvas', icon: <Bookmark size={16} />, run: () => actions.onCanvas(m) },
    canEdit && { label: 'Edit', icon: <Pencil size={16} />, run: startEdit },
    mine && m.sender.type === 'user' && { label: 'Delivery status', icon: <Clock size={16} />, run: () => actions.onDelivery(m) },
    canDelete && { label: 'Delete', icon: <Trash2 size={16} />, run: () => actions.onDelete(m), danger: true },
  ];
  const menu = candidates.filter((x): x is MenuItem => !!x);
  const bare = m.payload.type === 'block';
  const timeBelow = mine || !showName;

  return (
    <article
      id={`m-${m.seq}`}
      aria-label={`${m.sender.name} at ${timeLabel(m.createdAt)}`}
      className={cx('group relative rounded-xl px-2 sm:px-3', compact ? 'py-0.5' : 'mt-2.5 pt-0.5 pb-0.5', highlighted && 'animate-pulse-line')}
    >
      {m.payload.type === 'resolution' ? (
        <ResolutionCard m={m} actions={actions} canOpen={canOpenResolution} />
      ) : (
        <div className={cx('flex items-end gap-2', mine && 'flex-row-reverse')}>
          {!mine && <div className="w-8 shrink-0">{!compact && <Avatar name={m.sender.name} size={32} />}</div>}
          <div className={cx('flex min-w-0 flex-col', mine ? 'items-end' : 'items-start', bare ? 'w-full max-w-md' : 'max-w-[82%]')}>
            <div className={cx('min-w-0 max-w-full', !bare && 'rounded-[18px] px-3.5 py-2', !bare && (mine ? 'st-bubble-mine rounded-br-md bg-bubble-mine text-on-bubble-mine' : 'rounded-bl-md border border-line bg-surface'))}>
            {!mine && !compact && (showName || m.sender.type === 'guest') && (
              <header className="flex flex-wrap items-center gap-x-2">
                <span className="text-xs font-bold text-ink-2">{m.sender.name}</span>
                {m.sender.type === 'guest' && <Pill tone="crystal">Guest</Pill>}
                <time className="font-mono text-[11px] text-ink-3" dateTime={m.createdAt}>
                  {timeLabel(m.createdAt)}
                </time>
              </header>
            )}
            {m.replyTo && (
              <a href={`#m-${m.replyTo.seq}`} className="mb-1 block max-w-md truncate rounded-md border-l-2 border-current bg-tint-plain px-2 py-0.5 text-[13px] text-ink-2">
                <span className="font-medium">{m.replyTo.senderName}</span> {m.replyTo.excerpt}
              </a>
            )}
            {editing ? (
              <form
                className="my-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) actions.onEdit(m, draft.trim());
                  setEditing(false);
                }}
              >
                <Textarea value={draft} rows={2} autoFocus onChange={(e) => setDraft(e.target.value)} aria-label="Edit message" />
                <div className="mt-1 flex gap-2">
                  <Button type="submit" variant="primary" className="h-8">
                    Save
                  </Button>
                  <Button variant="ghost" className="h-8" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              body
            )}
            </div>
            {(m.editedAt || posture || m.refCount > 0 || receipt || (!compact && timeBelow)) && !editing && (
              <div className={cx('mt-0.5 flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-ink-3', mine && 'justify-end')}>
                {timeBelow && !compact && <time className="font-mono" dateTime={m.createdAt}>{timeLabel(m.createdAt)}</time>}
                {m.editedAt && !deleted && <span>edited</span>}
                {posture && (
                  <Pill tone={posture.tone}>
                    {posture.icon} {posture.label}
                  </Pill>
                )}
                {m.refCount > 0 && (
                  <button type="button" onClick={() => actions.onShowRefs(m)} className="inline-flex items-center gap-1 text-crystal hover:underline">
                    <Bookmark size={11} /> On Canvas
                  </button>
                )}
                {receipt && (
                  <span className="inline-flex items-center gap-1">
                    <CheckCheck size={12} /> {receipt}
                  </span>
                )}
              </div>
            )}
            {m.reactions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {m.reactions.map((r) => (
                  <button
                    key={r.emoji}
                    type="button"
                    disabled={readOnly}
                    aria-pressed={r.principalIds.includes(meId)}
                    onClick={() => actions.onReact(m, r.emoji)}
                    className={cx('st-press inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs', r.principalIds.includes(meId) ? 'border-violet bg-tint-violet' : 'border-line hover:border-line-strong')}
                  >
                    {r.emoji} <span className="font-mono">{r.principalIds.length}</span>
                  </button>
                ))}
              </div>
            )}
            {m.ack && <AckBar m={m} meId={meId} actions={actions} />}
            {branches.length > 0 && <BranchStem branches={branches} actions={actions} />}
          </div>
        </div>
      )}

      {!deleted && !readOnly && (
        <>
          <div className={cx('st-glass invisible absolute -top-3 z-10 flex items-center rounded-xl p-0.5 opacity-0 shadow-float transition-opacity duration-200 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 max-sm:!hidden', mine ? 'left-2' : 'right-2')}>
            <div className="relative">
              <IconButton label="React" className="size-7" onClick={() => setPicker((v) => !v)}>
                <Smile size={15} />
              </IconButton>
              {picker && (
                <div className="st-glass absolute top-full right-0 z-20 mt-1 flex rounded-xl p-1 shadow-float animate-rise">
                  {QUICK.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`React with ${emoji}`}
                      onClick={() => {
                        actions.onReact(m, emoji);
                        setPicker(false);
                      }}
                      className="size-7 rounded st-press hover:bg-tint-plain"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {menu.map((item) => (
              <IconButton key={item.label} label={item.label} className={cx('size-7', item.danger && 'hover:text-alert')} onClick={item.run}>
                {item.icon}
              </IconButton>
            ))}
          </div>
          <IconButton label="Message actions" className={cx('absolute bottom-0 size-9 text-ink-3 sm:hidden', mine ? 'left-0' : 'right-0')} onClick={() => setSheet(true)}>
            <MoreHorizontal size={16} />
          </IconButton>
        </>
      )}

      {sheet && (
        <Dialog title="Message" onClose={() => setSheet(false)}>
          <div className="mb-2 flex justify-between">
            {QUICK.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React with ${emoji}`}
                onClick={() => {
                  actions.onReact(m, emoji);
                  setSheet(false);
                }}
                className="size-11 rounded-lg text-xl st-press hover:bg-tint-plain"
              >
                {emoji}
              </button>
            ))}
          </div>
          {menu.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setSheet(false);
                item.run();
              }}
              className={cx('flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left st-press hover:bg-tint-plain', item.danger && 'text-alert')}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </Dialog>
      )}
    </article>
  );
}
