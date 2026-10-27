import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach } from 'vitest';
import { CustomFiltersSection } from './CustomFilters';
import { appliedStore } from './appliedStore';
import { filtersStore, termsKey } from './filtersStore';

const KEY = 'safewatch.customFilters.v1';
beforeEach(() => { window.localStorage.clear(); filtersStore.reload(); appliedStore.reset(); });

const add = async (phrase: string) => {
  const input = screen.getByLabelText('Word or phrase');
  await userEvent.clear(input);
  await userEvent.type(input, phrase);
  await userEvent.click(screen.getByRole('button', { name: 'Add' }));
};

describe('Custom filters UI', () => {
  it('explains itself and shows an empty state', () => {
    render(<CustomFiltersSection />);
    expect(screen.getByRole('heading', { name: 'Custom filters' })).toBeInTheDocument();
    expect(screen.getByText('Choose words or phrases SafeWatch should detect.')).toBeInTheDocument();
    expect(screen.getByText(/No filters yet\. Add a word or phrase/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Your filters' })).not.toBeInTheDocument();
  });
  it('adds a filter by pressing Enter, clears the field and lists it', async () => {
    render(<CustomFiltersSection />);
    await userEvent.type(screen.getByLabelText('Word or phrase'), 'SafeWatch{Enter}');
    const list = screen.getByRole('list', { name: 'Your filters' });
    expect(within(list).getByText('SafeWatch')).toBeInTheDocument();
    expect(within(list).getByText('Whole word')).toBeInTheDocument();
    expect(screen.getByLabelText('Word or phrase')).toHaveValue('');
  });
  it('adds with the button too, and lets the user choose the match mode', async () => {
    render(<CustomFiltersSection />);
    await userEvent.selectOptions(screen.getByLabelText('Match'), 'phrase');
    await add('safe watch');
    expect(within(screen.getByRole('list', { name: 'Your filters' })).getByText('Phrase')).toBeInTheDocument();
    expect(screen.getByText(/ignoring spacing and punctuation/)).toBeInTheDocument();
  });
  it('rejects empty and whitespace-only input with an accessible message', async () => {
    render(<CustomFiltersSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    const input = screen.getByLabelText('Word or phrase');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a word or phrase.');
    await add('   ');
    expect(screen.getByText('Enter a word or phrase.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Your filters' })).not.toBeInTheDocument();
  });
  it('rejects punctuation-only and over-long input', async () => {
    render(<CustomFiltersSection />);
    await add('?!…');
    expect(screen.getByText('Include at least one letter or number.')).toBeInTheDocument();
    await add('x'.repeat(230));
    expect(screen.getByText(/under 200 characters/)).toBeInTheDocument();
  });
  it('prevents duplicates (case and width differences included) but allows another mode', async () => {
    render(<CustomFiltersSection />);
    await add('Hello');
    await add('  HELLO ');
    expect(screen.getByText('You already have that filter.')).toBeInTheDocument();
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    await userEvent.selectOptions(screen.getByLabelText('Match'), 'exact');
    await add('Hello');
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });
  it('clears the error as soon as the user edits', async () => {
    render(<CustomFiltersSection />);
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Enter a word or phrase.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Word or phrase'), 'a');
    expect(screen.queryByText('Enter a word or phrase.')).not.toBeInTheDocument();
  });
  it('toggles a filter with a labelled switch, by mouse and keyboard', async () => {
    render(<CustomFiltersSection />);
    await add('alpha');
    const sw = screen.getByRole('switch', { name: 'Detect “alpha”' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveTextContent('Enabled');
    await userEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveTextContent('Off');
    sw.focus();
    await userEvent.keyboard(' ');
    expect(sw).toHaveAttribute('aria-checked', 'true');
  });
  it('removes a filter via an accessibly named button', async () => {
    render(<CustomFiltersSection />);
    await add('alpha');
    await add('beta');
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter “alpha”' }));
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });
  it('persists in this browser and restores on reload, including the enabled flag', async () => {
    const { unmount } = render(<CustomFiltersSection />);
    await add('alpha');
    await userEvent.click(screen.getByRole('switch'));
    unmount();
    filtersStore.reload();
    render(<CustomFiltersSection />);
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });
  it('ignores corrupt or hostile stored data instead of trusting it', () => {
    window.localStorage.setItem(KEY, JSON.stringify([{ id: 1 }, null, { id: 'x', phrase: '', matchMode: 'phrase', createdAt: 'z' }, { id: 'ok', phrase: 'fine', matchMode: 'phrase', enabled: true, createdAt: 'z' }]));
    filtersStore.reload();
    render(<CustomFiltersSection />);
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    window.localStorage.setItem(KEY, '{ not json');
    filtersStore.reload();
    expect(() => render(<CustomFiltersSection />)).not.toThrow();
  });
  it('keeps working when storage throws (private mode, quota)', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    render(<CustomFiltersSection />);
    await add('alpha');
    expect(screen.getByText('alpha')).toBeInTheDocument();
    spy.mockRestore();
  });
  it('renders hostile phrases as inert text', async () => {
    render(<CustomFiltersSection />);
    const evil = '<img src=x onerror=alert(1)> <script>window.__x=1</script>';
    await add(evil);
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
  it('says accurately what it does: finds the words in speech and subtitles, can warn, mute or skip on request, learns nothing', () => {
    render(<CustomFiltersSection />);
    expect(screen.getByText(/finds where your words and phrases occur in a video’s speech and subtitles/)).toBeInTheDocument();
    expect(screen.getByText(/does not learn new ideas from your list and does not understand what a sentence means/)).toBeInTheDocument();
  });
  it('states honestly where the list goes: saved in this browser, enabled phrases sent to the SafeWatch server, nothing to anyone else', () => {
    render(<CustomFiltersSection />);
    const note = screen.getByText(/Your list is saved in this browser/);
    expect(note).toHaveTextContent('the enabled phrases are sent to your SafeWatch server');
    expect(note).toHaveTextContent('does not store or log them');
    expect(note).toHaveTextContent('For a YouTube video the matching happens in this browser and nothing goes to the server');
    expect(note).toHaveTextContent('never sent to YouTube or to anyone else');
    expect(document.body.textContent).not.toMatch(/never leave|never sent anywhere|never sent to (the )?(server|SafeWatch)|stay in this browser/i);
  });

  describe('editing', () => {
    const edit = async (name: RegExp, phrase: string) => {
      await userEvent.click(screen.getByRole('button', { name }));
      const input = screen.getByLabelText('Edit phrase');
      await userEvent.clear(input);
      await userEvent.type(input, phrase);
    };
    it('edits the phrase and the match mode in place, keeping the enabled state', async () => {
      render(<CustomFiltersSection />);
      await add('colour');
      await userEvent.click(screen.getByRole('switch', { name: /Detect “colour”/ }));
      await userEvent.click(screen.getByRole('button', { name: /Edit filter “colour”/ }));
      expect(screen.getByLabelText('Edit phrase')).toHaveFocus();
      await userEvent.clear(screen.getByLabelText('Edit phrase'));
      await userEvent.type(screen.getByLabelText('Edit phrase'), 'color');
      await userEvent.selectOptions(screen.getAllByLabelText('Match')[1]!, 'exact');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      const item = within(screen.getByRole('list', { name: 'Your filters' })).getByText('color').closest('li')!;
      expect(item).toHaveTextContent('Exact case');
      expect(within(item).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
      expect(screen.queryByText('colour')).not.toBeInTheDocument();
      expect(JSON.parse(window.localStorage.getItem(KEY)!)[0]).toMatchObject({ phrase: 'color', matchMode: 'exact', enabled: false });
    });
    it('applies the same rules as adding: empty, punctuation-only, too long and duplicate are rejected with a message and nothing changes', async () => {
      render(<CustomFiltersSection />);
      await add('alpha'); await add('beta');
      await edit(/Edit filter “beta”/, '   ');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText('Enter a word or phrase.')).toBeInTheDocument();
      await userEvent.clear(screen.getByLabelText('Edit phrase')); await userEvent.type(screen.getByLabelText('Edit phrase'), '!!!');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText('Include at least one letter or number.')).toBeInTheDocument();
      await userEvent.clear(screen.getByLabelText('Edit phrase')); await userEvent.type(screen.getByLabelText('Edit phrase'), 'ALPHA');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText('You already have that filter.')).toBeInTheDocument();
      expect(JSON.parse(window.localStorage.getItem(KEY)!).map((f: { phrase: string }) => f.phrase)).toEqual(['alpha', 'beta']);
    });
    it('saving a filter unchanged is allowed (it is not a duplicate of itself)', async () => {
      render(<CustomFiltersSection />);
      await add('alpha');
      await userEvent.click(screen.getByRole('button', { name: /Edit filter “alpha”/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.queryByText('You already have that filter.')).not.toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Your filters' })).toHaveTextContent('alpha');
    });
    it('Cancel and Escape leave the filter as it was', async () => {
      render(<CustomFiltersSection />);
      await add('alpha');
      await edit(/Edit filter “alpha”/, 'changed');
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByText('alpha')).toBeInTheDocument();
      await edit(/Edit filter “alpha”/, 'changed again');
      await userEvent.keyboard('{Escape}');
      expect(screen.getByText('alpha')).toBeInTheDocument();
      expect(screen.queryByLabelText('Edit phrase')).not.toBeInTheDocument();
    });
  });

  describe('saved, active and not yet applied', () => {
    const status = () => screen.queryByTestId('filters-status');
    it('says nothing about the list while it is empty, then that it is saved here and used when a video is analyzed', async () => {
      render(<CustomFiltersSection />);
      expect(status()).not.toBeInTheDocument();
      await add('alpha');
      expect(status()).toHaveTextContent('Saved in this browser. They are used when you analyze a video.');
    });
    it('shows that the open video’s findings are being updated, are active, or could not be updated', async () => {
      render(<CustomFiltersSection />);
      await add('alpha');
      act(() => appliedStore.pending());
      expect(status()).toHaveTextContent('Updating the open video’s findings…');
      act(() => appliedStore.applied(termsKey(filtersStore.getSnapshot())));
      expect(status()).toHaveTextContent('Saved and active: this list is used in the open video’s findings.');
      expect(status()).toHaveTextContent('the speech and subtitles are not processed again');
      act(() => appliedStore.failed());
      expect(status()).toHaveTextContent('could not be updated: they still show the earlier list');
    });
    it('notices when the list changed after the analysis: not yet applied, then active again once it is', async () => {
      render(<CustomFiltersSection />);
      await add('alpha');
      act(() => appliedStore.applied(termsKey(filtersStore.getSnapshot())));
      await add('beta');
      expect(status()).toHaveTextContent('findings use an earlier list and update in a moment');
      act(() => appliedStore.applied(termsKey(filtersStore.getSnapshot())));
      expect(status()).toHaveTextContent('Saved and active');
    });
    it('disabling a phrase changes the applied list too (only enabled phrases count)', async () => {
      render(<CustomFiltersSection />);
      await add('alpha');
      act(() => appliedStore.applied(termsKey(filtersStore.getSnapshot())));
      await userEvent.click(screen.getByRole('switch', { name: /Detect “alpha”/ }));
      expect(status()).toHaveTextContent('earlier list');
    });
    it('never says the model learns, and never says phrases stay on the device', () => {
      render(<CustomFiltersSection />);
      expect(document.body.textContent).not.toMatch(/will learn|teaches the model|stay on this device|never leave|never sent anywhere|never sent to (the )?(server|SafeWatch)/i);
      expect(document.body.textContent).toContain('does not learn new ideas from your list');
    });
  });
});
