// JSON read/write for per-viewer UI conveniences (a collapsed section, a
// remembered choice). Storage can be unavailable or throw — private
// browsing, blocked site data, a full quota — so every access is guarded and
// a failed read falls back to the caller's default. Never use this for
// state that must persist reliably.

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort — the preference just won't survive a reload
  }
}
