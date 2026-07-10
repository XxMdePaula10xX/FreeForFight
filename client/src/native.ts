// Capacitor / native glue. No-ops on the web — everything is guarded by
// isNativePlatform() so the browser build is unaffected.

import { Capacitor } from '@capacitor/core';

export async function initNative(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // Dark = light text, for our dark dojo background.
    await StatusBar.setStyle({ style: Style.Dark });
  } catch {
    /* status-bar plugin not installed on this platform — ignore */
  }
}

export const isNative = (): boolean => Capacitor.isNativePlatform();
