import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui';
import { toastError } from '../../state/store';
import { acceptKeyChange, useE2ee } from './service';

/**
 * Shown when a person's key is not the one this device remembers. Nothing is shared with the new key until it's accepted,
 * because this is exactly what it would look like if someone were impersonating them.
 */
export function KeyChangeNotice({ roomId, onView }: { roomId: string; onView: () => void }) {
  const changed = useE2ee((s) => s.changed[roomId]);
  const [busy, setBusy] = useState<string | null>(null);
  if (!changed?.length) return null;

  return (
    <section aria-label="Security code changed" className="border-b border-line bg-tint-alert px-4 py-2.5">
      {changed.map((person) => (
        <div key={person.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <ShieldAlert size={16} className="shrink-0 text-alert" aria-hidden />
          <p className="min-w-0 flex-1 text-[13px] text-ink">
            <span className="font-semibold">{person.name}'s security code changed.</span> That happens when they reset their keys or sign in on a new device, and it's also what an
            impersonator would look like. Messages aren't shared with the new code until you accept it.
          </p>
          <div className="flex gap-2">
            <Button className="h-8 px-3 text-xs" onClick={onView}>
              Compare codes
            </Button>
            <Button
              className="h-8 px-3 text-xs"
              variant="primary"
              busy={busy === person.userId}
              onClick={() => {
                setBusy(person.userId);
                acceptKeyChange(roomId, person.userId)
                  .catch(toastError)
                  .finally(() => setBusy(null));
              }}
            >
              Accept new code
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
