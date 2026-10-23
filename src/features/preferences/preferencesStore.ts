import { useSyncExternalStore } from 'react';
import { DEFAULT_PREFERENCES, parsePreferences, type Preferences } from '@/domain/preferences/preferences';
import { createLocalStore } from '@/lib/localStore';

/** Preferences live in this browser only (localStorage), are validated on read, and are never sent anywhere. */
const store = createLocalStore<Preferences>({ key: 'safewatch.preferences.v1', parse: parsePreferences });

export const preferencesStore = {
  getSnapshot: store.getSnapshot,
  subscribe: store.subscribe,
  /** Applies a change on top of the current values and validates the result, so an invalid value can never be stored. */
  update(change: Partial<Preferences>) { store.set(parsePreferences({ ...store.getSnapshot(), ...change })); },
  reset() { store.set(DEFAULT_PREFERENCES); },
  reload: store.reload,
};

export const usePreferences = (): Preferences => useSyncExternalStore(preferencesStore.subscribe, preferencesStore.getSnapshot, preferencesStore.getSnapshot);
