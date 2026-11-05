import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'quiet' | 'ghost' | 'danger' | 'vein';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-paper hover:opacity-90',
  vein: 'bg-vein text-on-accent hover:opacity-90',
  quiet: 'bg-surface text-ink border border-line hover:border-line-strong',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink',
  danger: 'bg-oxide text-on-accent hover:opacity-90',
};

export function Button({ variant = 'quiet', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition disabled:opacity-50',
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function IconButton({ label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx('inline-flex size-9 items-center justify-center rounded-lg text-ink-2 transition hover:bg-sunken hover:text-ink disabled:opacity-40', className)}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

const INPUT = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-[15px] text-ink placeholder:text-ink-3 outline-none transition focus:border-vein';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(INPUT, className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(INPUT, 'resize-none', className)} />;
}

export function Avatar({ name, url, size = 36, online }: { name: string; url?: string | null; size?: number; online?: boolean }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('');
  // The hue comes from the name, so a person keeps their colour everywhere.
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 20);
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" className="size-full rounded-full object-cover" />
      ) : (
        <span
          aria-hidden
          className="flex size-full items-center justify-center rounded-full font-medium"
          style={{ background: `hsl(${hue} 32% 82%)`, color: `hsl(${hue} 42% 26%)`, fontSize: size * 0.38 }}
        >
          {initials || '?'}
        </span>
      )}
      {online && <span className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-paper bg-vein" aria-label="Online" />}
    </span>
  );
}

/** A centered dialog on desktop, and a sheet from the bottom edge on phones. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  // Callers pass inline functions. Keeping the latest in a ref means a parent re-render, such as a message arriving,
  // doesn't rerun the effect below and pull focus away from whatever is being typed.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href]')].filter((el) => !el.hasAttribute('disabled'));
      const [head, tail] = [items[0], items.at(-1)];
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault();
        tail?.focus();
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault();
        head?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 animate-fade sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          'flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-surface shadow-float animate-rise sm:rounded-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <h2 id={titleId} className="font-serif text-xl font-medium">
            {title}
          </h2>
          <IconButton label="Close" data-close onClick={onClose} className="-mr-2">
            <X size={18} />
          </IconButton>
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" aria-label={label} className="inline-flex gap-1">
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1 w-3 rounded-full bg-ink-3 animate-pulse" style={{ animationDelay: `${i * 140}ms` }} />
      ))}
    </span>
  );
}

export function Pill({ tone, children }: { tone: 'vein' | 'copper' | 'oxide' | 'lilac' | 'plain'; children: ReactNode }) {
  const tones = {
    vein: 'bg-vein-soft text-vein',
    copper: 'bg-copper-soft text-copper',
    oxide: 'bg-oxide-soft text-oxide',
    lilac: 'bg-lilac-soft text-lilac',
    plain: 'bg-sunken text-ink-2',
  };
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-sm flex-col items-center gap-2 px-6 py-12 text-center">
      <div className="layer-rule w-24" />
      <h3 className="mt-2 font-serif text-lg">{title}</h3>
      {children && <p className="text-sm text-ink-2">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const dayLabel = (iso: string) => {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};

export const shortTime = (iso: string) => {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? timeLabel(iso) : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
