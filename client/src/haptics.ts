// Tactile feedback. Uses Capacitor Haptics on device, falls back to the Web
// Vibration API in a browser. All calls are no-ops when disabled or unsupported.
// Press feedback fires from input.ts; outcome feedback (land/parry/KO) fires
// from real sim events so it never triggers on a whiffed tap.

import { isNative } from './native';

let enabled = true;
export function setHapticsEnabled(v: boolean): void {
  enabled = v;
}

// Cache the dynamically-imported plugin so we don't re-import every buzz.
let plugin: typeof import('@capacitor/haptics') | null = null;
async function native() {
  if (!plugin) plugin = await import('@capacitor/haptics');
  return plugin;
}

function webVibrate(pattern: number | number[]): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* some browsers throw if not user-activated — ignore */
    }
  }
}

function fire(webPattern: number | number[], run: (h: typeof import('@capacitor/haptics')) => void): void {
  if (!enabled) return;
  if (isNative()) {
    native().then(run).catch(() => webVibrate(webPattern));
  } else {
    webVibrate(webPattern);
  }
}

// A light tick when you press a button.
export function hapticPress(): void {
  fire(8, (h) => h.Haptics.impact({ style: h.ImpactStyle.Light }));
}

// A firm bump when your push actually shoves someone.
export function hapticPushLand(): void {
  fire(18, (h) => h.Haptics.impact({ style: h.ImpactStyle.Medium }));
}

// A crisp double-tap when a parry lands — the money moment.
export function hapticReflectHit(): void {
  fire([12, 40, 14], (h) => h.Haptics.notification({ type: h.NotificationType.Success }));
}

// A heavy thud when you're knocked out (or knock someone out).
export function hapticEliminated(): void {
  fire(45, (h) => h.Haptics.impact({ style: h.ImpactStyle.Heavy }));
}
