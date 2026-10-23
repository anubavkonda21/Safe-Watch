import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach } from 'vitest';
import { preferencesStore } from '@/features/preferences/preferencesStore';
import { PlaybackPreferences } from './PlaybackPreferences';

beforeEach(() => { window.localStorage.clear(); preferencesStore.reload(); });
const open = async () => { render(<PlaybackPreferences />); await userEvent.click(screen.getByText('Preferences')); };

describe('PlaybackPreferences', () => {
  it('offers only what SafeWatch can honour, with the recommended values marked', async () => {
    await open();
    expect(screen.getByRole('switch', { name: 'Warn me before a flagged phrase' })).toBeChecked();
    const lead = screen.getByLabelText('Warn me this far ahead');
    expect(lead).toHaveValue('20');
    expect([...(lead as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['10 seconds', '20 seconds (recommended)', '30 seconds']);
    const dur = screen.getByLabelText('Keep the warning visible for');
    expect(dur).toHaveValue('3');
    expect([...(dur as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['3 seconds (recommended)', '5 seconds', '8 seconds']);
  });
  it('applies and remembers each change in this browser', async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText('Warn me this far ahead'), '30');
    await userEvent.selectOptions(screen.getByLabelText('Keep the warning visible for'), '8');
    await userEvent.click(screen.getByRole('switch', { name: 'Warn me before a flagged phrase' }));
    expect(preferencesStore.getSnapshot()).toMatchObject({ leadSeconds: 30, durationSeconds: 8, warningsEnabled: false });
    expect(JSON.parse(window.localStorage.getItem('safewatch.preferences.v1')!)).toMatchObject({ leadSeconds: 30 });
  });
  it('disables the timing choices while warnings are off, and restores defaults on request', async () => {
    preferencesStore.update({ warningsEnabled: false, leadSeconds: 10 });
    await open();
    expect(screen.getByLabelText('Warn me this far ahead')).toBeDisabled();
    expect(screen.getByLabelText('Keep the warning visible for')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Restore defaults' }));
    expect(preferencesStore.getSnapshot()).toMatchObject({ warningsEnabled: true, leadSeconds: 20, durationSeconds: 3 });
  });
  it('explains plainly that a warning is a heads-up, that doing nothing changes nothing, and that nothing is sent anywhere', async () => {
    await open();
    const text = document.body.textContent!;
    expect(text).toContain('if you do nothing it goes away and playback continues unchanged');
    expect(text).toContain('You can always dismiss it');
    expect(text).toContain('saved in this browser only');
  });
  it('has no way to enable acting on everything, and no option for unsupported categories', async () => {
    await open();
    expect(document.body.textContent).not.toMatch(/everything|all categories|violence|sexual|drug|gore|censor/i);
  });
});
