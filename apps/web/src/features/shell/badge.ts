import { useStore } from '../../state/store';

const BASE = 'Strata';

/** Unread count in the tab title and, on an installed app, on its icon, so there's a sign even from another window. */
export function startBadge() {
  let last = -1;
  const apply = () => {
    const unread = Object.values(useStore.getState().rooms).reduce((sum, r) => sum + (r.me.role ? r.me.unread : 0), 0);
    if (unread === last) return;
    last = unread;
    document.title = unread > 0 ? `(${unread > 99 ? '99+' : unread}) ${BASE}` : BASE;
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (unread > 0) void nav.setAppBadge?.(unread).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  };
  useStore.subscribe(apply);
  apply();
}
