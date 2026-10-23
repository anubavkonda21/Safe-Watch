/**
 * A tiny browser-local store: one JSON value in localStorage under a key, validated on every read, with an in-memory copy so
 * the page keeps working when storage is blocked or full (private windows, quota). Subscribable for useSyncExternalStore.
 * Nothing here touches the network. localStorage is NOT encrypted and is readable by anything running on this page's origin.
 */
export interface LocalStore<T> {
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
  set(next: T): void;
  /** Forget the in-memory copy so the next read goes to storage again (tests, and after storage changed elsewhere). */
  reload(): void;
}

export function createLocalStore<T>(options: { key: string; parse: (raw: unknown) => T }): LocalStore<T> {
  let cache: T | null = null;
  const listeners = new Set<() => void>();
  const load = (): T => {
    try { return options.parse(JSON.parse(window.localStorage.getItem(options.key) ?? 'null')); } catch { return options.parse(null); }
  };
  return {
    getSnapshot: () => (cache ??= load()),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next) {
      cache = next;
      try { window.localStorage.setItem(options.key, JSON.stringify(next)); } catch { /* keep working in memory */ }
      listeners.forEach((l) => l());
    },
    reload() { cache = null; listeners.forEach((l) => l()); },
  };
}
