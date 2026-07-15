// Capacitor / native glue. No-ops on the web — everything is guarded by
// isNativePlatform() so the browser build is unaffected.

import { Capacitor } from '@capacitor/core';

export async function initNative(onBack?: () => void): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // Dark = light text, for our dark dojo background.
    await StatusBar.setStyle({ style: Style.Dark });
  } catch {
    /* status-bar plugin not installed on this platform — ignore */
  }
  // Android hardware Back: without a handler Capacitor exits the app, so a Back
  // press mid-match would quit. Route it to the app's own navigation logic.
  if (onBack) {
    try {
      const { App } = await import('@capacitor/app');
      App.addListener('backButton', () => onBack());
    } catch {
      /* app plugin unavailable — ignore */
    }
  }
}

// Minimize/exit the app (used only from the home screen).
export async function exitApp(): Promise<void> {
  try {
    const { App } = await import('@capacitor/app');
    await App.exitApp();
  } catch {
    /* ignore */
  }
}

export const isNative = (): boolean => Capacitor.isNativePlatform();
