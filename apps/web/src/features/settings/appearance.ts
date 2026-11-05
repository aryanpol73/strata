import type { Appearance } from '@strata/shared';
import { create } from 'zustand';
import { api } from '../../api/client';

const KEY = 'strata:appearance';

export const DEFAULT_APPEARANCE: Appearance = { accent: 'violet', mode: 'dark', appIcon: 'violet', textSize: 'default', reduceMotion: false };

const BACKGROUNDS = { violet: { dark: '#0b0914', light: '#f4f1fb' }, emerald: { dark: '#07100d', light: '#eff8f4' } };

function stored(): Appearance {
  try {
    return { ...DEFAULT_APPEARANCE, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Appearance>) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export const useAppearance = create<Appearance>(stored);

const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)');

function setLink(rel: string, href: string) {
  document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)?.setAttribute('href', href);
}

function apply(a: Appearance) {
  const root = document.documentElement;
  const light = a.mode === 'light' || (a.mode === 'system' && prefersLight().matches);
  const set = (name: string, value: string | null) => {
    if (value) root.dataset[name] = value;
    else delete root.dataset[name];
  };
  set('theme', light ? 'day' : null);
  set('accent', a.accent === 'violet' ? null : a.accent);
  set('text', a.textSize === 'default' ? null : a.textSize);
  set('motion', a.reduceMotion ? 'reduced' : null);

  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BACKGROUNDS[a.accent][light ? 'light' : 'dark']);
  setLink('icon', `/icons/${a.appIcon}-64.png`);
  setLink('apple-touch-icon', `/icons/${a.appIcon}-apple.png`);
  setLink('manifest', `/manifest-${a.appIcon}.webmanifest`);
}

function keep(next: Appearance) {
  useAppearance.setState(next, true);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows can refuse storage, and the choice still applies for this visit.
  }
  apply(next);
}

/** Runs before the first paint, so nobody sees the wrong theme flash up. */
export function startAppearance() {
  apply(useAppearance.getState());
  prefersLight().addEventListener('change', () => apply(useAppearance.getState()));
}

/** A saved choice follows the person to each device they sign in on. */
export function adoptAppearance(saved: Appearance | null) {
  if (saved) keep(saved);
}

export async function changeAppearance(patch: Partial<Appearance>) {
  const next = { ...useAppearance.getState(), ...patch };
  keep(next);
  await api('/users/me', { method: 'PATCH', body: { appearance: next } });
}
