import { BellOff, BellRing, Check, Clock, Feather, Layers } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Posture } from '@strata/shared';
import { Input, cx } from '../../components/ui';

interface Option {
  id: Posture;
  label: string;
  hint: string;
  icon: ReactNode;
  tone: string;
}

export const POSTURE_OPTIONS: Option[] = [
  { id: 'standard', label: 'Standard', hint: 'Notifies people now', icon: <Feather size={16} />, tone: 'text-ink-2' },
  { id: 'whisper', label: 'Whisper', hint: 'In the conversation, with no notification', icon: <BellOff size={16} />, tone: 'text-lilac' },
  { id: 'digest', label: 'Digest', hint: "Waits for each person's next batch", icon: <Layers size={16} />, tone: 'text-copper' },
  { id: 'blocking_ack', label: 'Needs acknowledgement', hint: 'Everyone must confirm by a deadline', icon: <BellRing size={16} />, tone: 'text-oxide' },
];

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);

function tomorrowMorning() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function PosturePicker({
  posture,
  deadline,
  onChange,
}: {
  posture: Posture;
  deadline: Date | null;
  onChange: (posture: Posture, deadline: Date | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = POSTURE_OPTIONS.find((o) => o.id === posture)!;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const choose = (id: Posture) => {
    if (id === 'blocking_ack') {
      onChange(id, deadline ?? hoursFromNow(4));
      return;
    }
    onChange(id, null);
    setOpen(false);
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Delivery: ${current.label}. Change`}
        title={`Delivery: ${current.label}`}
        onClick={() => setOpen((v) => !v)}
        className={cx('inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium transition hover:bg-sunken', current.tone)}
      >
        {current.icon}
        {posture !== 'standard' && <span className="max-w-24 truncate max-sm:hidden">{current.label}</span>}
      </button>

      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-1.5 shadow-float animate-rise">
          <p className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-ink-3">How should this reach people?</p>
          {POSTURE_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={posture === o.id}
              onClick={() => choose(o.id)}
              className={cx('flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-sunken', posture === o.id && 'bg-sunken')}
            >
              <span className={cx('mt-0.5', o.tone)}>{o.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-ink-2">{o.hint}</span>
              </span>
              {posture === o.id && <Check size={16} className="mt-0.5 text-vein" />}
            </button>
          ))}
          {posture === 'blocking_ack' && (
            <div className="mt-1 border-t border-line px-2.5 pt-2 pb-1.5">
              <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-ink-2">
                <Clock size={12} /> Deadline
              </p>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {[
                  ['1 hour', hoursFromNow(1)],
                  ['4 hours', hoursFromNow(4)],
                  ['Tomorrow 9am', tomorrowMorning()],
                ].map(([label, date]) => (
                  <button key={label as string} type="button" onClick={() => onChange('blocking_ack', date as Date)} className="rounded-full border border-line px-2.5 py-0.5 text-xs transition hover:border-oxide hover:text-oxide">
                    {label as string}
                  </button>
                ))}
              </div>
              <Input
                type="datetime-local"
                aria-label="Deadline"
                value={deadline ? toLocalInput(deadline) : ''}
                min={toLocalInput(new Date())}
                onChange={(e) => e.target.value && onChange('blocking_ack', new Date(e.target.value))}
                className="py-1 text-sm"
              />
              <button type="button" onClick={() => setOpen(false)} className="mt-2 w-full rounded-lg bg-oxide py-1.5 text-sm font-medium text-on-accent">
                Use this deadline
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
