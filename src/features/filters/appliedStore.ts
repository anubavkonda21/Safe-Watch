import { useSyncExternalStore } from 'react';

/**
 * Which phrase list the OPEN video's safety analysis was made with. Memory only (it describes the page right now). The Safety
 * panel reports; the phrase list shows whether the current list has been applied or is still being applied.
 */
export type AppliedState = { status: 'idle' } | { status: 'pending' } | { status: 'applied'; key: string } | { status: 'failed' };

let state: AppliedState = { status: 'idle' };
const listeners = new Set<() => void>();
const set = (next: AppliedState) => { state = next; listeners.forEach((l) => l()); };

export const appliedStore = {
  getSnapshot: (): AppliedState => state,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  pending: () => { if (state.status !== 'pending') set({ status: 'pending' }); },
  applied: (key: string) => set({ status: 'applied', key }),
  failed: () => set({ status: 'failed' }),
  reset: () => { if (state.status !== 'idle') set({ status: 'idle' }); },
};

export const useAppliedState = (): AppliedState => useSyncExternalStore(appliedStore.subscribe, appliedStore.getSnapshot, appliedStore.getSnapshot);
