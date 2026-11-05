import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ExternalLink, GripVertical, Link2, MessageSquareQuote, Plus, Scale, StickyNote, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CanvasBlockDTO, CanvasContent, CanvasDTO, CanvasSectionDTO } from '@strata/shared';
import { ApiError, api } from '../../api/client';
import { Button, EmptyState, IconButton, Input, Pill, Spinner, Textarea, cx, shortTime } from '../../components/ui';
import type { StrataSocket } from '../../realtime/socket';
import { toast, toastError } from '../../state/store';
import { BlockCard, type BlockActor } from '../blocks/BlockCard';

interface PanelProps {
  roomId: string;
  readOnly: boolean;
  focusBlockId: string | null;
  socket: StrataSocket | null;
  actor: BlockActor;
  load?: () => Promise<CanvasDTO>;
  onJumpToMessage?: (seq: number) => void;
  liveBlockType?: (blockId: string) => string | undefined;
}

const fetchCanvas = (roomId: string) => api<{ canvas: CanvasDTO }>(`/rooms/${roomId}/canvas`).then((r) => r.canvas);

function SourceChip({ block, onJump }: { block: CanvasBlockDTO; onJump?: (seq: number) => void }) {
  const source = block.source;
  if (!source) return null;
  if (!source.available) return <p className="mt-1.5 text-xs text-ink-3">Original message deleted</p>;
  return (
    <button type="button" onClick={() => onJump?.(source.seq)} className="mt-1.5 inline-flex max-w-full items-center gap-1 font-sans text-xs text-ink-2 transition hover:text-crystal">
      <MessageSquareQuote size={12} className="shrink-0" />
      <span className="truncate">
        {source.senderName} · {shortTime(source.sentAt)}
      </span>
    </button>
  );
}

function EditableText({ block, readOnly, onSave, className }: { block: CanvasBlockDTO; readOnly: boolean; onSave: (text: string) => void; className: string }) {
  const value = 'text' in block.content ? block.content.text : '';
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (readOnly) return <p className={cx('whitespace-pre-wrap', className)}>{value}</p>;
  return (
    <textarea
      value={draft}
      rows={Math.max(1, Math.ceil(draft.length / 44), draft.split('\n').length)}
      aria-label="Canvas text"
      placeholder="Write something"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onSave(draft)}
      className={cx('w-full resize-none bg-transparent outline-none', className)}
    />
  );
}

function BlockContent({ block, panel, save }: { block: CanvasBlockDTO; panel: PanelProps; save: (content: CanvasContent) => void }) {
  const { content } = block;
  switch (content.kind) {
    case 'text':
      return <EditableText block={block} readOnly={panel.readOnly} className="font-serif text-[16px] leading-relaxed" onSave={(text) => save({ kind: 'text', text })} />;
    case 'quote':
      return (
        <div className="border-l-2 border-crystal pl-3">
          <EditableText block={block} readOnly={panel.readOnly} className="font-serif text-[16px] leading-relaxed italic" onSave={(text) => save({ kind: 'quote', text })} />
        </div>
      );
    case 'decision':
      return (
        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <Scale size={13} className="text-crystal" />
            <button
              type="button"
              disabled={panel.readOnly}
              onClick={() => save({ ...content, status: content.status === 'decided' ? 'superseded' : content.status === 'superseded' ? 'proposed' : 'decided' })}
              title="Change status"
            >
              <Pill tone={content.status === 'decided' ? 'crystal' : content.status === 'proposed' ? 'whisper' : 'plain'}>{content.status}</Pill>
            </button>
          </div>
          <EditableText
            block={block}
            readOnly={panel.readOnly}
            className={cx('font-serif text-[17px] leading-snug font-medium', content.status === 'superseded' && 'text-ink-3 line-through')}
            onSave={(text) => save({ ...content, text })}
          />
        </div>
      );
    case 'link':
      return (
        <a href={content.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2 text-sm text-branch hover:underline">
          <Link2 size={15} className="shrink-0" />
          <span className="truncate">{content.title || content.url}</span>
          <ExternalLink size={12} className="shrink-0 opacity-60" />
        </a>
      );
    case 'live': {
      const type = panel.liveBlockType?.(content.blockId);
      return type ? <BlockCard blockId={content.blockId} type={type} fallbackTitle="Shared block" socket={panel.socket} actor={panel.actor} history={false} /> : <LiveEmbed blockId={content.blockId} panel={panel} />;
    }
  }
}

/** A live block whose type we don't know yet, for example after a reload straight into the Canvas. */
function LiveEmbed({ blockId, panel }: { blockId: string; panel: PanelProps }) {
  const [type, setType] = useState<string | null>(null);
  useEffect(() => {
    api<{ block: { type: string } }>(`/blocks/${blockId}`)
      .then((r) => setType(r.block.type))
      .catch(() => {});
  }, [blockId]);
  if (!type) return <Spinner />;
  return <BlockCard blockId={blockId} type={type} fallbackTitle="Shared block" socket={panel.socket} actor={panel.actor} history={false} />;
}

function SortableBlock({ block, panel, save, remove }: { block: CanvasBlockDTO; panel: PanelProps; save: (b: CanvasBlockDTO, c: CanvasContent) => void; remove: (b: CanvasBlockDTO) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: block.id, disabled: panel.readOnly });
  const focused = panel.focusBlockId === block.id;
  return (
    <li
      ref={setNodeRef}
      id={`cb-${block.id}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cx('group relative -mx-2 rounded-lg px-2 py-2 transition-colors', isDragging && 'z-10 bg-surface shadow-float', focused && 'animate-pulse-line')}
    >
      {!panel.readOnly && (
        <div className="absolute top-1.5 right-1 flex opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 max-lg:opacity-100">
          <IconButton label="Remove from Canvas" className="size-7 hover:text-alert" onClick={() => remove(block)}>
            <Trash2 size={14} />
          </IconButton>
          <button type="button" aria-label="Drag to reorder" className="flex size-7 cursor-grab touch-none items-center justify-center rounded-lg text-ink-3 hover:bg-tint-plain active:cursor-grabbing" {...attributes} {...listeners}>
            <GripVertical size={15} />
          </button>
        </div>
      )}
      <div className="pr-14">
        <BlockContent block={block} panel={panel} save={(c) => save(block, c)} />
        <SourceChip block={block} onJump={panel.onJumpToMessage} />
      </div>
    </li>
  );
}

function AddBar({ onAdd }: { onAdd: (content: CanvasContent) => void }) {
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState('');
  if (linking) {
    return (
      <form
        className="mt-1 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^https?:\/\//i.test(url)) return toast('Links need to start with http:// or https://', 'error');
          onAdd({ kind: 'link', url, title: '' });
          setUrl('');
          setLinking(false);
        }}
      >
        <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label="Link address" className="py-1 text-sm" />
        <Button type="submit" className="h-8">
          Add
        </Button>
      </form>
    );
  }
  const item = (label: string, icon: ReactNode, run: () => void) => (
    <button type="button" onClick={run} className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-3 st-press hover:bg-tint-plain hover:text-ink">
      {icon} {label}
    </button>
  );
  return (
    <div className="mt-1 flex gap-0.5">
      {item('Note', <StickyNote size={13} />, () => onAdd({ kind: 'text', text: '' }))}
      {item('Decision', <Scale size={13} />, () => onAdd({ kind: 'decision', text: '', status: 'proposed' }))}
      {item('Link', <Link2 size={13} />, () => setLinking(true))}
    </div>
  );
}

function Section({
  section,
  blocks,
  panel,
  deletable,
  actions,
}: {
  section: CanvasSectionDTO;
  blocks: CanvasBlockDTO[];
  panel: PanelProps;
  deletable: boolean;
  actions: {
    save: (b: CanvasBlockDTO, c: CanvasContent) => void;
    remove: (b: CanvasBlockDTO) => void;
    add: (sectionId: string, c: CanvasContent) => void;
    rename: (id: string, title: string) => void;
    drop: (id: string) => void;
  };
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `section:${section.id}`, disabled: panel.readOnly });
  const [title, setTitle] = useState(section.title);
  useEffect(() => setTitle(section.title), [section.title]);

  return (
    <section ref={setNodeRef} className={cx('rounded-lg transition-colors', isOver && 'bg-tint-crystal/40')}>
      <div className="layer-rule mb-2" />
      <header className="group flex items-center gap-1">
        {panel.readOnly ? (
          <h3 className="font-serif text-lg font-medium">{section.title}</h3>
        ) : (
          <input
            value={title}
            aria-label="Section title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== section.title && actions.rename(section.id, title.trim())}
            className="min-w-0 flex-1 bg-transparent font-serif text-lg font-medium outline-none"
          />
        )}
        {deletable && !panel.readOnly && (
          <IconButton label={`Delete section ${section.title}`} className="size-7 opacity-0 group-hover:opacity-100 focus:opacity-100 max-lg:opacity-100" onClick={() => actions.drop(section.id)}>
            <Trash2 size={14} />
          </IconButton>
        )}
      </header>
      <SortableContext items={blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
        <ul className="min-h-2">
          {blocks.map((b) => (
            <SortableBlock key={b.id} block={b} panel={panel} save={actions.save} remove={actions.remove} />
          ))}
        </ul>
      </SortableContext>
      {!panel.readOnly && <AddBar onAdd={(c) => actions.add(section.id, c)} />}
    </section>
  );
}

export function CanvasPanel(props: PanelProps) {
  const { roomId, readOnly, focusBlockId, load } = props;
  const [canvas, setCanvas] = useState<CanvasDTO | null>(null);
  const [newSection, setNewSection] = useState('');

  const refresh = useCallback(() => {
    return (load ? load() : fetchCanvas(roomId)).then(setCanvas).catch(toastError);
  }, [roomId, load]);

  useEffect(() => {
    setCanvas(null);
    void refresh();
    const onChange = (e: Event) => {
      if ((e as CustomEvent<{ roomId: string }>).detail.roomId === roomId) void refresh();
    };
    window.addEventListener('strata:canvas', onChange);
    return () => window.removeEventListener('strata:canvas', onChange);
  }, [roomId, refresh]);

  useEffect(() => {
    if (focusBlockId) document.getElementById(`cb-${focusBlockId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusBlockId, canvas]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const bySection = useMemo(() => {
    const groups = new Map<string, CanvasBlockDTO[]>();
    for (const b of canvas?.blocks ?? []) groups.set(b.sectionId, [...(groups.get(b.sectionId) ?? []), b]);
    return groups;
  }, [canvas]);

  const save = async (block: CanvasBlockDTO, content: CanvasContent) => {
    try {
      await api(`/canvas/blocks/${block.id}`, { method: 'PATCH', body: { content, version: block.version } });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') toast('Someone else just edited this. Their version is shown.', 'error');
      else toastError(err);
      await refresh();
    }
  };

  const actions = {
    save,
    remove: async (b: CanvasBlockDTO) => {
      await api(`/canvas/blocks/${b.id}`, { method: 'DELETE' }).catch(toastError);
      await refresh();
    },
    add: async (sectionId: string, content: CanvasContent) => {
      await api(`/rooms/${roomId}/canvas/blocks`, { method: 'POST', body: { sectionId, content } }).catch(toastError);
      await refresh();
    },
    rename: async (id: string, title: string) => {
      await api(`/rooms/${roomId}/canvas/sections/${id}`, { method: 'PATCH', body: { title } }).catch(toastError);
    },
    drop: async (id: string) => {
      await api(`/rooms/${roomId}/canvas/sections/${id}`, { method: 'DELETE' }).catch(toastError);
      await refresh();
    },
  };

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!canvas || !over || active.id === over.id) return;
    const moving = canvas.blocks.find((b) => b.id === active.id);
    if (!moving) return;

    const overId = String(over.id);
    const sectionId = overId.startsWith('section:') ? overId.slice(8) : canvas.blocks.find((b) => b.id === overId)?.sectionId;
    if (!sectionId) return;

    const siblings = (bySection.get(sectionId) ?? []).filter((b) => b.id !== moving.id);
    const movingDown = moving.sectionId === sectionId && (bySection.get(sectionId) ?? []).findIndex((b) => b.id === moving.id) < (bySection.get(sectionId) ?? []).findIndex((b) => b.id === overId);
    const overIndex = siblings.findIndex((b) => b.id === overId);
    const index = overIndex === -1 ? siblings.length : overIndex + (movingDown ? 1 : 0);

    // Show the result immediately. The server's answer replaces it a moment later.
    const reordered = [...siblings.slice(0, index), { ...moving, sectionId }, ...siblings.slice(index)];
    setCanvas({ ...canvas, blocks: [...canvas.blocks.filter((b) => b.sectionId !== sectionId && b.id !== moving.id), ...reordered] });

    await api(`/canvas/blocks/${moving.id}/move`, {
      method: 'POST',
      body: { sectionId, afterId: siblings[index - 1]?.id ?? null, beforeId: siblings[index]?.id ?? null },
    }).catch(toastError);
    await refresh();
  };

  if (!canvas) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner label="Loading Canvas" />
      </div>
    );
  }

  const empty = canvas.blocks.length === 0;

  return (
    <div className="scroll-thin h-full overflow-y-auto px-5 py-4">
      {empty && !readOnly && <EmptyState title="Nothing has settled here yet">Add any message from the conversation with the bookmark on it, and it'll stay here, linked back to where it was said.</EmptyState>}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <div className="space-y-5">
          {canvas.sections.map((section) => (
            <Section key={section.id} section={section} blocks={bySection.get(section.id) ?? []} panel={props} deletable={canvas.sections.length > 1} actions={actions} />
          ))}
        </div>
      </DndContext>
      {!readOnly && (
        <form
          className="mt-5 flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!newSection.trim()) return;
            await api(`/rooms/${roomId}/canvas/sections`, { method: 'POST', body: { title: newSection.trim() } }).catch(toastError);
            setNewSection('');
            await refresh();
          }}
        >
          <Plus size={15} className="text-ink-3" />
          <input value={newSection} onChange={(e) => setNewSection(e.target.value)} placeholder="New section" aria-label="New section title" className="min-w-0 flex-1 bg-transparent font-serif outline-none placeholder:text-ink-3" />
        </form>
      )}
    </div>
  );
}
