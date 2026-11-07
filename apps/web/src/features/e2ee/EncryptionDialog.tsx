import { Lock, LockOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RoomDTO, RoomKeysDTO } from '@strata/shared';
import { api } from '../../api/client';
import { Avatar, Dialog, Pill, Spinner } from '../../components/ui';
import { toastError, useStore } from '../../state/store';
import { securityCode } from './crypto';

interface Row {
  userId: string;
  displayName: string;
  code: string | null;
}

/** What is protected here, who holds the keys, and a code to check that nobody has been swapped for someone else. */
export function EncryptionDialog({ room, onClose }: { room: RoomDTO; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    if (!room.encryption.enabled) return;
    api<RoomKeysDTO>(`/e2ee/rooms/${room.id}`)
      .then(async (keys) => setRows(await Promise.all(keys.members.map(async (m) => ({ userId: m.userId, displayName: m.displayName, code: m.publicKey ? await securityCode(m.publicKey) : null })))))
      .catch(toastError);
  }, [room.id, room.encryption.enabled]);

  if (!room.encryption.enabled) {
    return (
      <Dialog title="Not end-to-end encrypted" onClose={onClose}>
        <div className="flex gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-crystal text-crystal">
            <LockOpen size={18} />
          </span>
          <div className="space-y-2 text-sm text-ink-2">
            <p>The server can read messages in this conversation. They're still protected in transit and where they're stored.</p>
            <p>That's the case for conversations started before encryption was set up, and for branches that allow guests, because a guest has no keys.</p>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="End-to-end encrypted" onClose={onClose} wide>
      <div className="flex gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-tint-violet text-violet">
          <Lock size={18} />
        </span>
        <p className="text-sm text-ink-2">Messages are encrypted on your device and can only be read by the people below. Strata's servers store scrambled text and can't open it.</p>
      </div>

      <h3 className="mt-4 mb-1 text-[13px] font-medium text-ink-2">Security codes</h3>
      <p className="mb-2 text-xs text-ink-2">To be sure nobody has been swapped for someone else, compare a person's code with the one on their own screen, in person or on a call.</p>
      {!rows ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.userId} className="flex items-center gap-3 py-2">
              <Avatar name={r.displayName} size={30} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {r.displayName} {r.userId === me.id && <span className="font-normal text-ink-3">(you)</span>}
                </p>
                {r.code ? <p className="font-mono text-xs tracking-wide text-ink-2">{r.code}</p> : <p className="text-xs text-ink-2">Hasn't set up encryption yet, so can't read these messages.</p>}
              </div>
              {!r.code && <Pill tone="crystal">Waiting</Pill>}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mt-4 mb-1 text-[13px] font-medium text-ink-2">What isn't encrypted</h3>
      <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-ink-2">
        <li>Who is in the conversation, and when messages were sent</li>
        <li>Files and images you attach</li>
        <li>Anything you add to the Canvas, live blocks, and branch titles and summaries</li>
        <li>The sender and room name shown in a notification</li>
      </ul>
    </Dialog>
  );
}
