import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/ui';

export const SELECT = 'w-full rounded-xl border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none transition focus:border-violet';

export function PageTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <header className="mb-5">
      <h2 className="text-[22px] leading-7 font-bold tracking-tight">{title}</h2>
      <p className="mt-0.5 text-sm text-ink-2">{hint}</p>
    </header>
  );
}

export function Card({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mb-4 rounded-2xl border border-line bg-surface">
      {title && (
        <header className="px-4 pt-3.5">
          <h3 className="text-[15px] font-bold">{title}</h3>
          {hint && <p className="mt-0.5 text-[13px] text-ink-2">{hint}</p>}
        </header>
      )}
      <div className="divide-y divide-line px-4 py-1">{children}</div>
    </section>
  );
}

/** One setting: what it is on the left, its control on the right. Stacks when the control needs the width. */
export function Row({ label, hint, children, stack = false }: { label: string; hint?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={cx('py-3', stack ? 'space-y-2' : 'flex items-center justify-between gap-4')}>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        {hint && <p className="mt-0.5 text-[13px] text-ink-2">{hint}</p>}
      </div>
      {children && <div className={cx(!stack && 'shrink-0')}>{children}</div>}
    </div>
  );
}

export function Toggle({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative h-7 w-12 rounded-full border transition-colors duration-200 disabled:opacity-50', checked ? 'border-transparent bg-violet-fill' : 'border-line-strong bg-tint-plain')}
    >
      <span aria-hidden className={cx('absolute top-0.5 left-0.5 size-[22px] rounded-full bg-white shadow-card transition-transform duration-200', checked && 'translate-x-5')} />
    </button>
  );
}

/** A larger radio, for choices that are easier to judge by looking at them. */
export function Choice({ label, hint, selected, onSelect, children }: { label: string; hint?: string; selected: boolean; onSelect: () => void; children?: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cx('st-press relative flex min-w-0 flex-col gap-2 rounded-2xl border p-3 text-left', selected ? 'border-violet bg-tint-violet' : 'border-line-strong hover:bg-tint-plain')}
    >
      {children}
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        {hint && <span className="mt-0.5 block text-[13px] text-ink-2">{hint}</span>}
      </span>
      {selected && (
        <span aria-hidden className="absolute top-2 right-2 flex size-5 items-center justify-center rounded-full bg-violet-fill text-on-violet">
          <Check size={13} />
        </span>
      )}
    </button>
  );
}
