import { BellRing, X } from 'lucide-react';
import { useState } from 'react';
import { Button, IconButton } from '../../components/ui';
import { toast, toastError } from '../../state/store';
import { enablePush, pushState } from '../settings/push';

const KEY = 'strata:push-prompt';

const dismissed = () => {
  try {
    return localStorage.getItem(KEY) === 'dismissed';
  } catch {
    return false;
  }
};

/** Shown once, where people will see it, because buried in Settings is where most never turned notifications on. */
export function NotificationPrompt() {
  const [hidden, setHidden] = useState(dismissed);
  const [busy, setBusy] = useState(false);
  if (hidden || pushState() !== 'off') return null;

  const dismiss = () => {
    try {
      localStorage.setItem(KEY, 'dismissed');
    } catch {
      // Without storage it simply asks again next visit.
    }
    setHidden(true);
  };

  const turnOn = async () => {
    setBusy(true);
    try {
      const result = await enablePush();
      if (result === 'on') toast('Notifications are on for this device');
      else if (result === 'denied') toast('Notifications are blocked. Allow them in your browser settings to turn them on.', 'error');
      setHidden(true);
    } catch (err) {
      toastError(err);
    }
    setBusy(false);
  };

  return (
    <section aria-label="Turn on notifications" className="relative mb-3 rounded-2xl border border-line-strong bg-tint-violet p-3 pr-10">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-raised text-violet">
          <BellRing size={17} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">Get notified when someone writes</p>
          <p className="mt-0.5 text-[13px] text-ink-2">Without this you only hear about messages while Strata is open and in front of you.</p>
          <div className="mt-2 flex gap-2">
            <Button variant="primary" className="h-9 px-3 text-[13px]" busy={busy} onClick={turnOn}>
              Turn on
            </Button>
            <Button variant="ghost" className="h-9 px-3 text-[13px]" onClick={dismiss}>
              Not now
            </Button>
          </div>
        </div>
      </div>
      <IconButton label="Dismiss" className="absolute top-1 right-1 size-8" onClick={dismiss}>
        <X size={15} />
      </IconButton>
    </section>
  );
}
