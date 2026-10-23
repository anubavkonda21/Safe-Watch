import { DEFAULT_PREFERENCES, parsePreferences } from './preferences';

describe('parsePreferences', () => {
  it('has conservative defaults: warnings on, 20 s ahead, 3 s visible, no action unless the user chooses', () => {
    expect(DEFAULT_PREFERENCES).toEqual({ warningsEnabled: true, leadSeconds: 20, durationSeconds: 3, defaultAction: 'none' });
  });
  it('accepts valid values', () => {
    expect(parsePreferences({ warningsEnabled: false, leadSeconds: 30, durationSeconds: 8, defaultAction: 'mute' })).toEqual({ warningsEnabled: false, leadSeconds: 30, durationSeconds: 8, defaultAction: 'mute' });
  });
  it.each([null, undefined, 5, 'x', [], true])('falls back to the defaults for %j', (raw) => { expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES); });
  it('repairs field by field: one corrupt value never discards the others', () => {
    expect(parsePreferences({ warningsEnabled: 'yes', leadSeconds: 15, durationSeconds: 5, defaultAction: 'delete-everything' })).toEqual({ warningsEnabled: true, leadSeconds: 20, durationSeconds: 5, defaultAction: 'none' });
  });
  it.each([0, -1, 1e9, NaN, '20', null, 25])('rejects lead %j (only the offered options are valid)', (v) => { expect(parsePreferences({ leadSeconds: v }).leadSeconds).toBe(20); });
  it.each([0, 1, 60, NaN, '3', 4])('rejects duration %j', (v) => { expect(parsePreferences({ durationSeconds: v }).durationSeconds).toBe(3); });
  it('has no way to express "act on everything": the default action is only none, mute or skip, and ignore is not offered as a default', () => {
    expect(parsePreferences({ defaultAction: 'ignore' }).defaultAction).toBe('none');
    expect(parsePreferences({ defaultAction: 'censor-all' }).defaultAction).toBe('none');
  });
  it('ignores unknown and hostile keys', () => {
    const p = parsePreferences({ __proto__: { warningsEnabled: false }, constructor: 1, extra: 'x' });
    expect(p).toEqual(DEFAULT_PREFERENCES);
    expect(Object.keys(p).sort()).toEqual(['defaultAction', 'durationSeconds', 'leadSeconds', 'warningsEnabled']);
  });
});
