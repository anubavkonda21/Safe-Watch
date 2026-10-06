import { useSyncExternalStore } from 'react';
import { createCustomFilter, parseStoredFilters, type CustomFilter, type FilterResult, type MatchMode } from '@/domain/text/customFilter';

/**
 * Custom filters live in THIS browser only (localStorage): they are a
 * per-viewer convenience, never sent to the server, and matching runs in the
 * browser against the transcript the server returned. Stored data is
 * untrusted and re-validated on read. Every storage access is guarded
 * (private windows, blocked storage and quota errors must not break the page).
 */
const KEY = 'safewatch.customFilters.v1';

let cache: CustomFilter[] | null = null;
const listeners = new Set<() => void>();

function load(): CustomFilter[] {
  try {
    return parseStoredFilters(JSON.parse(window.localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

function save(next: CustomFilter[]) {
  cache = next;
  try { window.localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* keep working in memory */ }
  listeners.forEach((l) => l());
}

const snapshot = (): CustomFilter[] => (cache ??= load());
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

export const filtersStore = {
  getSnapshot: snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  add(phrase: string, mode: MatchMode): FilterResult {
    const result = createCustomFilter(phrase, mode, snapshot(), { id: newId(), now: new Date().toISOString() });
    if (result.ok) save([...snapshot(), result.filter]);
    return result;
  },
  toggle(id: string) { save(snapshot().map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f))); },
  remove(id: string) { save(snapshot().filter((f) => f.id !== id)); },
  /** Test helper: forget the in-memory copy so the next read goes to storage. */
  reload() { cache = null; listeners.forEach((l) => l()); },
};

export function useCustomFilters(): CustomFilter[] {
  return useSyncExternalStore(filtersStore.subscribe, filtersStore.getSnapshot, filtersStore.getSnapshot);
}
