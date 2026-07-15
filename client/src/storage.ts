// Web Storage access that never throws. In Safari private mode, sandboxed
// webviews, or with site-data blocked, localStorage/sessionStorage getters can
// throw SecurityError — which at module-eval time would blank-crash the app.

export function ssGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
export function ssSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage unavailable — degrade silently */
  }
}
export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — degrade silently */
  }
}
