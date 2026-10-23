import { useSyncExternalStore } from 'react';
import { createReport, parseStoredReports, type MissedReport, type ReportInput, type ReportResult } from '@/domain/feedback/report';
import { createLocalStore } from '@/lib/localStore';

/**
 * Missed-phrase reports live in THIS browser only (localStorage) for the user's own review. They are never sent anywhere,
 * never logged, and never become findings. Stored data is untrusted and re-validated on read.
 */
const store = createLocalStore<MissedReport[]>({ key: 'safewatch.feedback.v1', parse: parseStoredReports });

const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
/** A random id for one viewing of one video: it ties reports together without identifying the file. */
export const newSessionId = (): string => newId();

export const feedbackStore = {
  getSnapshot: store.getSnapshot,
  subscribe: store.subscribe,
  add(input: ReportInput, context: { session: string; durationMs: number | null }): ReportResult {
    const existing = store.getSnapshot();
    const result = createReport(input, { ...context, existingCount: existing.length, id: newId(), now: new Date().toISOString() });
    if (result.ok) store.set([result.report, ...existing]);
    return result;
  },
  remove(id: string) { store.set(store.getSnapshot().filter((r) => r.id !== id)); },
  clear() { store.set([]); },
  reload: store.reload,
};

export const useReports = (): MissedReport[] => useSyncExternalStore(feedbackStore.subscribe, feedbackStore.getSnapshot, feedbackStore.getSnapshot);
