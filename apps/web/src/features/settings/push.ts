import { api } from '../../api/client';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const keyBytes = (publicKey: string) => Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function subscribe(): Promise<void> {
  const { publicKey } = await api<{ publicKey: string | null }>('/notifications/push-key');
  if (!publicKey) throw new Error('This server has no push key yet. Try again in a moment.');
  const registration = await navigator.serviceWorker.ready;
  const sub = (await registration.pushManager.getSubscription()) ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  // Saving is an upsert, so doing it on every start also moves a subscription to whoever is signed in now.
  await api('/notifications/push-subscriptions', { method: 'POST', body: sub.toJSON() });
}

/** Asks the browser for permission, which has to come from a click, then subscribes this device. */
export async function enablePush(): Promise<'on' | 'denied' | 'unsupported'> {
  if (!pushSupported()) return 'unsupported';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  await subscribe();
  return 'on';
}

/** Once someone has said yes, a new sign-in, a new account or a cleared subscription shouldn't make them say it again. */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  await subscribe();
}

export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return;
  await api('/notifications/push-subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

export const pushState = (): 'unsupported' | 'blocked' | 'off' | 'on' => {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  return Notification.permission === 'granted' ? 'on' : 'off';
};
