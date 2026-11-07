import { useE2ee } from '../e2ee/service';
import { Check, Copy, GitBranch, Link2, Lock, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { payloadExcerpt, type GuestLinkCreated, type GuestLinkDTO, type MessageDTO, type RoomDTO } from '@strata/shared';
import { api } from '../../api/client';
import { Avatar, Button, Dialog, Field, Input, Pill, Spinner, Textarea, cx, shortTime } from '../../components/ui';
import { loadRoom } from '../../state/actions';
import { toast, toastError, useStore } from '../../state/store';

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 py-1">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-[var(--violet-fill)]" />
      <span>
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-xs text-ink-2">{hint}</span>}
      </span>
    </label>
  );
}

export function CreateBranchDialog({ message, room, onClose, onCreated }: { message: MessageDTO; room: RoomDTO; onClose: () => void; onCreated: (roomId: string) => void }) {
  const me = useStore((s) => s.me);
  const others = room.members.filter((m) => m.userId !== me?.id);
  const [title, setTitle] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [isPrivate, setPrivate] = useState(false);
  const [guests, setGuests] = useState(false);
  const [busy, setBusy] = useState(false);
  const opened = useE2ee((s) => s.clear[message.id]?.text);

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = async () => {
    setBusy(true);
    try {
      const res = await api<{ room: RoomDTO }>(`/messages/${message.id}/branches`, {
        method: 'POST',
        body: { title: title.trim(), participantIds: [...chosen], visibility: isPrivate ? 'private' : 'listed', encrypted: !guests },
      });
      useStore.getState().upsertRoom(res.room);
      onCreated(res.room.id);
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Branch from this message"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="branch" disabled={!title.trim()} busy={busy} onClick={create}>
            <GitBranch size={15} /> Start branch
          </Button>
        </>
      }
    >
      <blockquote className="mb-3 border-l-2 border-branch pl-3 text-sm text-ink-2">
        <span className="font-medium text-ink">{message.sender.name}</span> {opened ?? payloadExcerpt(message.payload, 160)}
      </blockquote>
      <div className="space-y-3">
        <Field label="What's this branch about?">
          <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Launch date" />
        </Field>
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-ink-2">Who should be in it?</legend>
          {others.length === 0 && <p className="text-sm text-ink-3">Nobody else is in this conversation yet.</p>}
          <ul className="scroll-thin max-h-44 overflow-y-auto">
            {others.map((m) => (
              <li key={m.userId}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-1 py-1.5 hover:bg-tint-plain">
                  <input type="checkbox" checked={chosen.has(m.userId)} onChange={() => toggle(m.userId)} className="size-4 accent-[var(--violet-fill)]" />
                  <Avatar name={m.displayName} url={m.avatarUrl} size={26} />
                  <span className="text-sm">{m.displayName}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <Toggle
          checked={isPrivate}
          onChange={setPrivate}
          label="Private branch"
          hint={isPrivate ? 'Others in the conversation won’t know this exists until you merge a resolution.' : 'Others can see the title and status, but not the messages.'}
        />
        {room.encryption.enabled && (
          <Toggle
            checked={guests}
            onChange={setGuests}
            label="Allow guests on this branch"
            hint={guests ? 'A guest has no encryption keys, so this branch will not be end-to-end encrypted.' : 'This branch is end-to-end encrypted, like the conversation it came from. Guests can’t be invited.'}
          />
        )}
      </div>
    </Dialog>
  );
}

export function ResolveDialog({ room, onClose }: { room: RoomDTO; onClose: () => void }) {
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const resolve = async () => {
    setBusy(true);
    try {
      await api(`/branches/${room.id}/resolve`, { method: 'POST', body: { summary: summary.trim() } });
      await loadRoom(room.id);
      onClose();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Resolve this branch"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!summary.trim()} busy={busy} onClick={resolve}>
            Mark resolved
          </Button>
        </>
      }
    >
      <Field label="What was decided?" hint="This becomes the resolution card if you merge. Write it for people who weren't here.">
        <Textarea rows={5} value={summary} maxLength={4000} onChange={(e) => setSummary(e.target.value)} />
      </Field>
      <p className="mt-2 text-xs text-ink-2">The branch closes to new messages. You can reopen it until it's merged.</p>
      {room.encryption.enabled && <p className="mt-1 text-xs text-ink-2">This summary isn't end-to-end encrypted, so that it can be posted back to the conversation and shown on the Canvas.</p>}
    </Dialog>
  );
}

export function MergeDialog({ room, onClose }: { room: RoomDTO; onClose: () => void }) {
  const [openTranscript, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const parent = useStore((s) => (room.parentRoomId ? s.rooms[room.parentRoomId] : undefined));

  const merge = async () => {
    setBusy(true);
    try {
      await api(`/branches/${room.id}/merge`, {
        method: 'POST',
        body: { transcriptPolicy: openTranscript ? 'parent_members' : 'participants' },
      });
      await loadRoom(room.id);
      toast('Resolution posted to the conversation');
      onClose();
    } catch (err) {
      toastError(err);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Merge resolution"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="branch" busy={busy} onClick={merge}>
            Post to {parent?.name ?? 'conversation'}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-sm text-ink-2">Everyone in the original conversation will see this card.</p>
      <div className="rounded-xl border border-crystal-line bg-tint-crystal p-3.5">
        <div className="layer-rule mb-2 w-28" />
        <h4 className="font-serif text-lg">{room.branch?.title}</h4>
        <p className="mt-1 whitespace-pre-wrap font-serif leading-relaxed">{room.branch?.resolution?.summary}</p>
      </div>
      {!room.encryption.enabled && <div className="mt-3">
        <Toggle
          checked={openTranscript}
          onChange={setOpen}
          label="Also share the transcript, read-only"
          hint={openTranscript ? 'Everyone in the parent conversation will be able to read every message in this branch.' : 'Only the summary is shared. The discussion stays with its participants.'}
        />
      </div>}
      {room.encryption.enabled && <p className="mt-3 text-xs text-ink-2">The discussion stays encrypted and private to its participants. Only this summary is shared.</p>}
      <p className="mt-2 text-xs text-ink-3">A merge can't be undone.</p>
    </Dialog>
  );
}

const EXPIRY = [
  { label: '1 day', hours: 24 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
];

export function GuestDialog({ room, onClose }: { room: RoomDTO; onClose: () => void }) {
  const [links, setLinks] = useState<GuestLinkDTO[] | null>(null);
  const [label, setLabel] = useState('');
  const [pin, setPin] = useState('');
  const [hours, setHours] = useState(168);
  const [write, setWrite] = useState(true);
  const [blocks, setBlocks] = useState(false);
  const [canvas, setCanvas] = useState(false);
  const [created, setCreated] = useState<GuestLinkCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () =>
    api<{ links: GuestLinkDTO[] }>(`/branches/${room.id}/guest-links`)
      .then((r) => setLinks(r.links))
      .catch(toastError);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  const create = async () => {
    try {
      const { link } = await api<{ link: GuestLinkCreated }>(`/branches/${room.id}/guest-links`, {
        method: 'POST',
        body: { label: label.trim(), pin: pin || undefined, expiresInHours: hours, scope: { write, blocks, canvas } },
      });
      setCreated(link);
      setLabel('');
      setPin('');
      await load();
    } catch (err) {
      toastError(err);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api(`/guest-links/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      toastError(err);
    }
  };

  // The token sits in the fragment, which browsers don't send to servers or put in Referer headers.
  const url = created ? `${location.origin}/g#t=${created.token}` : '';

  return (
    <Dialog title="Invite a guest" onClose={onClose} wide>
      {room.encryption.enabled ? (
        <p className="text-sm text-ink-2">
          This branch is end-to-end encrypted, so a guest couldn't read it. To invite a guest, start a new branch from the message and turn on “Allow guests on this branch”. Guest branches aren't end-to-end encrypted.
        </p>
      ) : (<>
      <div className="mb-3 flex gap-2 rounded-lg bg-tint-crystal p-2.5 text-sm text-ink-2">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-crystal" />
        <p>Guests can read everything in this branch, including messages from before they joined. They can't see the original conversation or anything else.</p>
      </div>

      {created ? (
        <div className="rounded-xl border border-branch bg-tint-branch p-3">
          <p className="mb-1.5 text-sm font-medium">Copy this link now. It won't be shown again.</p>
          <div className="flex gap-2">
            <Input readOnly value={url} aria-label="Guest link" className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button
              variant="branch"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <Button variant="ghost" className="mt-2 h-8" onClick={() => setCreated(null)}>
            Make another
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Who is this for?">
            <Input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="Vendor contact" />
          </Field>
          <Field label="PIN (optional)" hint="4 to 8 digits. Share it separately from the link.">
            <Input value={pin} inputMode="numeric" maxLength={8} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <div>
            <p className="mb-1 text-[13px] font-medium text-ink-2">Expires after</p>
            <div className="flex gap-1.5">
              {EXPIRY.map((e) => (
                <button
                  key={e.hours}
                  type="button"
                  aria-pressed={hours === e.hours}
                  onClick={() => setHours(e.hours)}
                  className={cx('rounded-lg border px-2.5 py-1.5 text-sm transition', hours === e.hours ? 'border-violet bg-tint-violet' : 'border-line hover:border-line-strong')}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-0.5 text-[13px] font-medium text-ink-2">They can</p>
            <Toggle checked={write} onChange={setWrite} label="Send messages" />
            <Toggle checked={blocks} onChange={setBlocks} label="Use shared blocks" />
            <Toggle checked={canvas} onChange={setCanvas} label="See the Canvas" />
          </div>
          <div className="sm:col-span-2">
            <Button variant="primary" disabled={!label.trim() || (pin.length > 0 && pin.length < 4)} onClick={create}>
              <Link2 size={15} /> Create link
            </Button>
          </div>
        </div>
      )}

      <h3 className="mt-5 mb-1.5 text-[13px] font-medium text-ink-2">Links</h3>
      {!links ? (
        <Spinner />
      ) : links.length === 0 ? (
        <p className="text-sm text-ink-3">None yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {links.map((l) => {
            const expired = new Date(l.expiresAt) < new Date();
            const live = !l.revokedAt && !expired;
            return (
              <li key={l.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {l.label} {l.hasPin && <Lock size={12} className="text-ink-3" aria-label="PIN protected" />}
                  </p>
                  <p className="text-xs text-ink-2">
                    {l.activeSessions} active · {live ? `until ${shortTime(l.expiresAt)}` : ''}
                  </p>
                </div>
                {l.revokedAt ? <Pill tone="plain">Revoked</Pill> : expired ? <Pill tone="plain">Expired</Pill> : null}
                {live && (
                  <Button className="h-8 hover:border-alert hover:text-alert" onClick={() => revoke(l.id)}>
                    <Trash2 size={14} /> Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      </>)}
    </Dialog>
  );
}

export function AddParticipantsDialog({ room, parent, onClose }: { room: RoomDTO; parent: RoomDTO | undefined; onClose: () => void }) {
  const inBranch = new Set(room.members.map((m) => m.userId));
  const candidates = (parent?.members ?? []).filter((m) => !inBranch.has(m.userId));
  const add = async (userId: string) => {
    try {
      await api(`/branches/${room.id}/participants`, { method: 'POST', body: { userIds: [userId] } });
      await loadRoom(room.id);
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Dialog title="Add to branch" onClose={onClose}>
      {candidates.length === 0 && <p className="text-sm text-ink-2">Everyone from the original conversation is already here.</p>}
      <ul>
        {candidates.map((m) => (
          <li key={m.userId}>
            <button type="button" onClick={() => add(m.userId)} className="flex w-full items-center gap-2.5 rounded-lg px-1 py-2 text-left st-press hover:bg-tint-plain">
              <Avatar name={m.displayName} url={m.avatarUrl} size={28} /> <span className="text-sm">{m.displayName}</span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
