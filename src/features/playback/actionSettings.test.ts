import { INITIAL_SETTINGS } from '@/domain/playback/actions';
import { settingsReducer } from './actionSettings';

describe('settingsReducer', () => {
  it('starts with automatic actions on and no action configured', () => {
    expect(INITIAL_SETTINGS).toEqual({ autoEnabled: true, choices: {}, defaultChoice: 'none' });
  });
  it('toggles the master switch and the default, returning the same state when nothing changes', () => {
    const off = settingsReducer(INITIAL_SETTINGS, { type: 'master', enabled: false });
    expect(off.autoEnabled).toBe(false);
    expect(settingsReducer(off, { type: 'master', enabled: false })).toBe(off);
    const mute = settingsReducer(INITIAL_SETTINGS, { type: 'default', choice: 'mute' });
    expect(mute.defaultChoice).toBe('mute');
    expect(settingsReducer(mute, { type: 'default', choice: 'mute' })).toBe(mute);
  });
  it('records a choice per finding, replaces it, and clears it (undo)', () => {
    let s = settingsReducer(INITIAL_SETTINGS, { type: 'choose', key: 'k', choice: 'ignore' });
    expect(s.choices).toEqual({ k: 'ignore' });
    s = settingsReducer(s, { type: 'choose', key: 'k', choice: 'skip' });
    expect(s.choices).toEqual({ k: 'skip' });
    s = settingsReducer(s, { type: 'clear', key: 'k' });
    expect(s.choices).toEqual({});
    expect(settingsReducer(s, { type: 'clear', key: 'k' })).toBe(s);
  });
  it('never mutates the previous state', () => {
    const before = JSON.stringify(INITIAL_SETTINGS);
    settingsReducer(INITIAL_SETTINGS, { type: 'choose', key: 'k', choice: 'mute' });
    settingsReducer(INITIAL_SETTINGS, { type: 'master', enabled: false });
    expect(JSON.stringify(INITIAL_SETTINGS)).toBe(before);
  });
  it('reset forgets everything', () => {
    const s = settingsReducer(settingsReducer(INITIAL_SETTINGS, { type: 'choose', key: 'k', choice: 'mute' }), { type: 'master', enabled: false });
    expect(settingsReducer(s, { type: 'reset' })).toEqual(INITIAL_SETTINGS);
  });
  it('a hostile key is just a key', () => {
    const s = settingsReducer(INITIAL_SETTINGS, { type: 'choose', key: '__proto__', choice: 'mute' });
    expect(Object.getPrototypeOf(s.choices)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).mute).toBeUndefined();
  });
});
