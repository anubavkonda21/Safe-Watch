import { beforeEach } from 'vitest';
import { DEFAULT_PREFERENCES } from '@/domain/preferences/preferences';
import { preferencesStore } from './preferencesStore';

const KEY = 'safewatch.preferences.v1';
beforeEach(() => { window.localStorage.clear(); preferencesStore.reload(); });

describe('preferencesStore', () => {
  it('starts with the conservative defaults and writes nothing until the user changes something', () => {
    expect(preferencesStore.getSnapshot()).toEqual(DEFAULT_PREFERENCES);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });
  it('persists a change in this browser and restores it after a reload', () => {
    preferencesStore.update({ leadSeconds: 30, defaultAction: 'mute' });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ ...DEFAULT_PREFERENCES, leadSeconds: 30, defaultAction: 'mute' });
    preferencesStore.reload();
    expect(preferencesStore.getSnapshot()).toMatchObject({ leadSeconds: 30, defaultAction: 'mute' });
  });
  it('can never store an invalid value: it is validated on the way in', () => {
    preferencesStore.update({ leadSeconds: 5 as never, durationSeconds: 999 as never, defaultAction: 'delete-all' as never });
    expect(preferencesStore.getSnapshot()).toEqual(DEFAULT_PREFERENCES);
  });
  it('handles corrupt and outdated stored data by falling back, field by field', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ warningsEnabled: false, leadSeconds: 'soon', oldField: 1 }));
    preferencesStore.reload();
    expect(preferencesStore.getSnapshot()).toEqual({ ...DEFAULT_PREFERENCES, warningsEnabled: false });
    window.localStorage.setItem(KEY, '{ not json');
    preferencesStore.reload();
    expect(preferencesStore.getSnapshot()).toEqual(DEFAULT_PREFERENCES);
  });
  it('reset restores the defaults', () => {
    preferencesStore.update({ warningsEnabled: false });
    preferencesStore.reset();
    expect(preferencesStore.getSnapshot()).toEqual(DEFAULT_PREFERENCES);
  });
});
