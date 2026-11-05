/**
 * Pointer effects for everything marked `.st-press`, from two listeners on the document rather than one per button.
 * The light tracks the pointer through CSS variables, so moving it causes no React renders.
 */
export function installPressEffects() {
  let frame = 0;
  let last: PointerEvent | null = null;
  const stillPlease = window.matchMedia('(prefers-reduced-motion: reduce)');

  const track = () => {
    frame = 0;
    if (!last) return;
    const target = (last.target as Element | null)?.closest?.<HTMLElement>('.st-press');
    if (!target) return;
    const box = target.getBoundingClientRect();
    target.style.setProperty('--mx', `${last.clientX - box.left}px`);
    target.style.setProperty('--my', `${last.clientY - box.top}px`);
  };

  document.addEventListener(
    'pointermove',
    (e) => {
      last = e;
      frame ||= requestAnimationFrame(track);
    },
    { passive: true },
  );

  document.addEventListener(
    'pointerdown',
    (e) => {
      const target = (e.target as Element | null)?.closest?.<HTMLElement>('.st-press');
      if (!target || (target as HTMLButtonElement).disabled || stillPlease.matches || document.documentElement.dataset.motion) return;
      const box = target.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'st-ripple';
      ripple.style.left = `${e.clientX - box.left}px`;
      ripple.style.top = `${e.clientY - box.top}px`;
      ripple.style.setProperty('--size', `${Math.hypot(box.width, box.height) * 2}px`);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
      target.append(ripple);
    },
    { passive: true },
  );
}
