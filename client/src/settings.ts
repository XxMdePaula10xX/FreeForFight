// Persisted player settings. A tiny store backed by localStorage that also
// reflects a few options onto the document (reduced-motion, larger text, and
// the left/right-handed control layout) so CSS can react.

export interface Settings {
  sound: boolean;
  haptics: boolean;
  reducedMotion: boolean;
  largeText: boolean;
  hand: 'R' | 'L';
}

const KEY = 'octogono_settings';

const DEFAULTS: Settings = {
  sound: true,
  haptics: true,
  reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  largeText: false,
  hand: 'R',
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export const settings: Settings = load();

type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();

export function onSettingsChange(fn: Listener): void {
  listeners.add(fn);
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settings[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode — settings just won't persist */
  }
  applyToDocument();
  for (const fn of listeners) fn(settings);
}

// Reflect the display-affecting settings onto <body> so CSS can respond.
export function applyToDocument(): void {
  document.body.classList.toggle('reduce-motion', settings.reducedMotion);
  document.body.classList.toggle('large-text', settings.largeText);
  document.body.dataset.hand = settings.hand;
}
