import { Check, Info, ListChecks, Paperclip, Plus, SendHorizontal, Users, X } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { ALLOWED_MIME, payloadExcerpt, type MessageDTO, type Posture, type SignedUpload } from '@strata/shared';
import { api } from '../../api/client';
import { IconButton, cx } from '../../components/ui';
import { getSocket } from '../../realtime/socket';
import { sendText } from '../../state/actions';
import { toast, toastError } from '../../state/store';
import { CreateBlockDialog, type BlockKind } from '../blocks/CreateBlockDialog';
import { PosturePicker } from './PosturePicker';

async function imageSize(file: File): Promise<{ width?: number; height?: number }> {
  if (!ALLOWED_MIME[file.type]?.image) return {};
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return {};
  }
}

async function upload(roomId: string, file: File) {
  const signed = await api<SignedUpload>('/media/sign', {
    method: 'POST',
    body: { roomId, name: file.name, mime: file.type, bytes: file.size },
  });
  if (signed.provider === 'cloudinary') {
    const form = new FormData();
    Object.entries(signed.fields).forEach(([k, v]) => form.set(k, v));
    form.set('file', file);
    const res = await fetch(signed.url, { method: 'POST', body: form });
    if (!res.ok) throw new Error('Upload failed');
  } else {
    await api(signed.url.replace(/^\/api/, ''), { method: 'PUT', raw: file, headers: signed.headers });
  }
  await api(`/media/${signed.assetId}/complete`, { method: 'POST', body: await imageSize(file) });
  await api(`/rooms/${roomId}/messages`, {
    method: 'POST',
    body: { clientMessageId: crypto.randomUUID(), content: { type: 'media', assetId: signed.assetId } },
  });
}

const TINT: Record<Posture, string> = {
  standard: 'border-line focus-within:border-line-strong',
  whisper: 'border-whisper/50 focus-within:border-whisper',
  digest: 'border-crystal/50 focus-within:border-crystal',
  blocking_ack: 'border-alert/60 focus-within:border-alert',
};

export function Composer({ roomId, replyTo, onClearReply, closedReason }: { roomId: string; replyTo: MessageDTO | null; onClearReply: () => void; closedReason: string | null }) {
  const [text, setText] = useState('');
  const [posture, setPosture] = useState<Posture>('standard');
  const [deadline, setDeadline] = useState<Date | null>(null);
  const [menu, setMenu] = useState(false);
  const [block, setBlock] = useState<BlockKind | null>(null);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const typingAt = useRef(0);

  useEffect(() => {
    setText('');
    setPosture('standard');
    setDeadline(null);
  }, [roomId]);

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  if (closedReason) {
    return (
      <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
        <p className="st-glass rounded-[20px] px-4 py-3 text-center text-sm text-ink-2">{closedReason}</p>
      </div>
    );
  }

  const announceTyping = (active: boolean) => {
    const now = Date.now();
    if (active && now - typingAt.current < 2000) return;
    typingAt.current = active ? now : 0;
    getSocket()?.emit('typing', { roomId, active });
  };

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    if (posture === 'blocking_ack' && (!deadline || deadline.getTime() < Date.now() + 60_000)) {
      toast('Pick a deadline at least a minute away', 'error');
      return;
    }
    setText('');
    onClearReply();
    announceTyping(false);
    sendText(roomId, body, { replyToId: replyTo?.id, posture, ackDeadline: deadline?.toISOString() }).catch(toastError);
    // Postures are per message, so the next one goes back to normal rather than silently repeating.
    setPosture('standard');
    setDeadline(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    e.target.value = '';
    if (!chosen) return;
    setUploading(true);
    try {
      await upload(roomId, chosen);
    } catch (err) {
      toastError(err);
    } finally {
      setUploading(false);
    }
  };

  const openBlock = (kind: BlockKind) => {
    setMenu(false);
    setBlock(kind);
  };

  const MENU = [
    { label: 'Checklist', icon: <ListChecks size={16} />, run: () => openBlock('checklist') },
    { label: 'Sign-up roster', icon: <Users size={16} />, run: () => openBlock('roster') },
    { label: 'Info card', icon: <Info size={16} />, run: () => openBlock('info') },
    {
      label: 'Attach a file',
      icon: <Paperclip size={16} />,
      run: () => {
        setMenu(false);
        file.current?.click();
      },
    },
  ];

  return (
    <div className="px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
      {replyTo && (
        <div className="mb-1 flex items-center gap-2 st-glass rounded-xl px-3 py-1.5 text-sm animate-settle">
          <span className="min-w-0 flex-1 truncate text-ink-2">
            Replying to <span className="font-medium text-ink">{replyTo.sender.name}</span>: {payloadExcerpt(replyTo.payload, 80)}
          </span>
          <IconButton label="Cancel reply" className="size-6" onClick={onClearReply}>
            <X size={14} />
          </IconButton>
        </div>
      )}
      {posture === 'blocking_ack' && deadline && (
        <p className="mb-1 flex items-center gap-1 px-1 text-xs text-alert">
          <Check size={12} /> Everyone must acknowledge by {deadline.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
        </p>
      )}
      <div className={cx('st-glass flex items-end gap-1 rounded-[20px] p-1 shadow-float transition-colors duration-200', TINT[posture])}>
        <div className="relative">
          <IconButton label="Add" aria-expanded={menu} disabled={uploading} onClick={() => setMenu((v) => !v)}>
            <Plus size={18} className={cx('transition', menu && 'rotate-45')} />
          </IconButton>
          {menu && (
            <div role="menu" className="st-glass absolute bottom-full left-0 z-30 mb-2 w-52 rounded-[20px] p-1.5 shadow-float animate-rise">
              {MENU.map((item) => (
                <button key={item.label} type="button" role="menuitem" onClick={item.run} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm st-press hover:bg-tint-plain">
                  <span className="text-ink-2">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <PosturePicker
          posture={posture}
          deadline={deadline}
          onChange={(p, d) => {
            setPosture(p);
            setDeadline(d);
          }}
        />
        <textarea
          ref={input}
          rows={1}
          value={text}
          aria-label="Message"
          placeholder={uploading ? 'Uploading…' : 'Write a message'}
          onChange={(e) => {
            setText(e.target.value);
            announceTyping(e.target.value.length > 0);
          }}
          onKeyDown={onKeyDown}
          className="min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] outline-none placeholder:text-ink-3"
        />
        <IconButton label="Send" disabled={!text.trim()} onClick={submit} className={cx(text.trim() && 'st-primary st-pop hover:text-on-violet')}>
          <SendHorizontal size={17} className="i-nudge" />
        </IconButton>
      </div>
      <input ref={file} type="file" hidden accept={Object.keys(ALLOWED_MIME).join(',')} onChange={onFile} />
      {block && <CreateBlockDialog roomId={roomId} kind={block} onClose={() => setBlock(null)} />}
    </div>
  );
}

