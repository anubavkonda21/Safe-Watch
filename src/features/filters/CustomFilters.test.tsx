import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach } from 'vitest';
import { CustomFiltersSection } from './CustomFilters';
import { filtersStore } from './filtersStore';

const KEY = 'safewatch.customFilters.v1';
beforeEach(() => { window.localStorage.clear(); filtersStore.reload(); });

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
    expect(screen.getByText(/No filters yet/)).toBeInTheDocument();
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
  it('says plainly that it only detects', () => {
    render(<CustomFiltersSection />);
    expect(screen.getByText(/does not mute, hide or change your video/)).toBeInTheDocument();
  });
});
