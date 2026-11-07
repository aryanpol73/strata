import webpush from 'web-push';
import { getEnv } from '../config/env.js';
import { Setting } from '../models/settings.js';
import { isDuplicateKey } from './errors.js';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

let cached: VapidKeys | null = null;
export const resetVapidCache = () => {
  cached = null;
};

/**
 * Push needs a key pair that never changes, because every browser subscription is tied to it. Setting one by hand is
 * the step people miss, so unless the environment supplies keys, the first node to ask makes a pair and keeps it in
 * MongoDB where every node, and every later restart, finds the same one.
 */
export async function getVapid(): Promise<VapidKeys> {
  const env = getEnv();
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  if (cached) return cached;
  try {
    const doc = await Setting.findOneAndUpdate({ _id: 'vapid' }, { $setOnInsert: { value: webpush.generateVAPIDKeys() } }, { upsert: true, returnDocument: 'after' }).lean();
    cached = doc?.value as VapidKeys;
  } catch (err) {
    // Two nodes tried to create it in the same instant, so the other one's pair is there to read.
    if (!isDuplicateKey(err)) throw err;
    cached = (await Setting.findById('vapid').lean())?.value as VapidKeys;
  }
  return cached;
}
