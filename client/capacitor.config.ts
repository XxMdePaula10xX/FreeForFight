import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the built web client (dist/) into a native iOS app.
// See README "Empacotar para a App Store".
const config: CapacitorConfig = {
  appId: 'com.matheus.octogono',
  appName: 'Octógono',
  webDir: 'dist',
  backgroundColor: '#0d0b0f',
  ios: {
    contentInset: 'never',
    backgroundColor: '#0d0b0f',
    // The game is a full-bleed canvas; let it draw under the notch and we pad
    // the UI with env(safe-area-inset-*) in CSS.
    limitsNavigationsToAppBoundDomains: false,
  },
  server: {
    // For a pure-offline solo build, nothing here is needed. If you want the
    // packaged app to reach your online server, it connects over wss:// using
    // VITE_WS_URL baked at build time (see README).
    iosScheme: 'octogono',
  },
};

export default config;
