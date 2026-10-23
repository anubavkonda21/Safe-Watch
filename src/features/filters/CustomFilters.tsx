import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Container } from '@/components/ui/Container';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { CloseIcon } from '@/components/ui/icons';
import { MATCH_MODES, MATCH_MODE_LABEL, MAX_PHRASE_LENGTH, type CustomFilter, type FilterRejection, type MatchMode } from '@/domain/text/customFilter';
import { cn } from '@/lib/cn';
import { useAppliedState } from './appliedStore';
import { filtersStore, termsKey, useCustomFilters } from './filtersStore';
import './filters.css';

const REJECTION_COPY: Record<FilterRejection, string> = {
  empty: 'Enter a word or phrase.',
  'too-long': `Keep it under ${MAX_PHRASE_LENGTH} characters.`,
  'no-words': 'Include at least one letter or number.',
  duplicate: 'You already have that filter.',
  'limit-reached': 'You have reached the maximum number of filters. Remove one to add another.',
  'not-found': 'That filter no longer exists.',
};

const MODE_OPTIONS = MATCH_MODES.map((m) => ({ value: m, label: MATCH_MODE_LABEL[m] }));
const MODE_HELP: Record<MatchMode, string> = {
  'word-boundary': 'Matches the whole word only: “art” does not match “party”.',
  phrase: 'Whole words, ignoring spacing and punctuation: “SafeWatch” also matches “safe watch”.',
  'case-insensitive': 'Matches anywhere in the text, even inside longer words, ignoring capitals.',
  exact: 'Matches anywhere in the text, capitals must be identical.',
};

/** Whether the saved list is the one the open video's analysis used. Plain statements only; nothing here claims more than is known. */
function listStatus(filters: readonly CustomFilter[], applied: ReturnType<typeof useAppliedState>): string {
  if (filters.length === 0) return '';
  if (applied.status === 'idle') return 'Saved in this browser. They are used when you analyze a video.';
  if (applied.status === 'pending') return 'Saved. Updating the open video’s findings…';
  if (applied.status === 'failed') return 'Saved, but the open video’s findings could not be updated: they still show the earlier list.';
  return applied.key === termsKey(filters)
    ? 'Saved and active: this list is used in the open video’s findings. Changing it re-matches the open video automatically; the speech and subtitles are not processed again.'
    : 'Saved. The open video’s findings use an earlier list and update in a moment.';
}

/**
 * "Custom filters": the words or phrases the user wants SafeWatch to flag. It finds where they OCCUR in speech and subtitles.
 * It is a text match: adding a phrase does not teach anything to a model, and it does not make SafeWatch understand meaning.
 */
export function CustomFiltersSection() {
  const filters = useCustomFilters();
  const applied = useAppliedState();
  const [phrase, setPhrase] = useState('');
  const [mode, setMode] = useState<MatchMode>('word-boundary');
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const result = filtersStore.add(phrase, mode);
    if (!result.ok) { setError(REJECTION_COPY[result.reason]); return; }
    setError(undefined);
    setPhrase('');
  }

  const status = listStatus(filters, applied);

  return (
    <section id="filters" className="sw-section" aria-labelledby="filters-title">
      <Container>
        <div className="sw-section__head">
          <Badge>Early preview</Badge>
          <h2 id="filters-title" className="sw-h1">Custom filters</h2>
          <p className="sw-body-lg sw-muted">Choose words or phrases SafeWatch should detect.</p>
        </div>

        <div className="sw-filters">
          <p className="sw-body-sm sw-muted sw-filters__how">
            SafeWatch finds where your words and phrases occur in a video’s speech and subtitles, and can warn you before them, then mute or skip them if you choose. It matches the text you type. It does not learn new ideas from your list and does not understand what a sentence means.
          </p>
          <form className="sw-filters__form" onSubmit={submit} noValidate>
            <Input
              label="Word or phrase"
              value={phrase}
              maxLength={MAX_PHRASE_LENGTH + 20}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. SafeWatch"
              error={error}
              onChange={(e) => { setPhrase(e.target.value); if (error) setError(undefined); }}
            />
            <Select label="Match" value={mode} options={MODE_OPTIONS} hint={MODE_HELP[mode]} onChange={(e) => setMode(e.target.value as MatchMode)} />
            <Button type="submit" className="sw-filters__add">Add</Button>
          </form>

          {filters.length === 0 ? (
            <p className="sw-body-sm sw-muted sw-filters__empty">No filters yet. Add a word or phrase to have it flagged in the speech and subtitles of a video you analyze.</p>
          ) : (
            <ul className="sw-filters__list" aria-label="Your filters">
              {filters.map((f) => (
                <li key={f.id} className={cn('sw-filter', !f.enabled && 'is-off')}>
                  {editing === f.id ? (
                    <EditRow filter={f} onDone={() => setEditing(null)} />
                  ) : (
                    <>
                      <div className="sw-filter__text">
                        <span className="sw-filter__phrase">{f.phrase}</span>
                        <span className="sw-caption sw-muted">{MATCH_MODE_LABEL[f.matchMode]}</span>
                      </div>
                      <button type="button" className="sw-filter__edit sw-caption" aria-label={`Edit filter “${f.phrase}”`} onClick={() => setEditing(f.id)}>Edit</button>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={f.enabled}
                        aria-label={`Detect “${f.phrase}”`}
                        className="sw-switch"
                        onClick={() => filtersStore.toggle(f.id)}
                      >
                        <span className="sw-caption sw-switch__label">{f.enabled ? 'Enabled' : 'Off'}</span>
                      </button>
                      <IconButton label={`Remove filter “${f.phrase}”`} onClick={() => filtersStore.remove(f.id)}><CloseIcon size={16} /></IconButton>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {status && <p className="sw-caption sw-muted sw-filters__status" data-testid="filters-status">{status}</p>}
          <p className="sw-caption sw-muted sw-filters__note">
            Your list is saved in this browser. When you analyze a video, the enabled phrases are sent to your SafeWatch server so it can find them in the transcript and subtitles; the server does not store or log them, and nothing is sent to anyone else.
          </p>
        </div>
      </Container>
    </section>
  );
}

function EditRow({ filter, onDone }: { filter: CustomFilter; onDone: () => void }) {
  const [phrase, setPhrase] = useState(filter.phrase);
  const [mode, setMode] = useState<MatchMode>(filter.matchMode);
  const [error, setError] = useState<string | undefined>();

  function save(e: FormEvent) {
    e.preventDefault();
    const result = filtersStore.update(filter.id, phrase, mode);
    if (!result.ok) { setError(REJECTION_COPY[result.reason]); return; }
    onDone();
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(); } };
  const inputId = `filter-edit-${filter.id}`;
  // Moving focus into the field the user just asked to edit is the expected behaviour (and returns to the page on Save or Cancel).
  useEffect(() => { document.getElementById(inputId)?.focus(); }, [inputId]);

  return (
    <form className="sw-filter__edit-form" onSubmit={save} noValidate>
      <Input id={inputId} label="Edit phrase" value={phrase} maxLength={MAX_PHRASE_LENGTH + 20} autoComplete="off" spellCheck={false} error={error} onKeyDown={onKey} onChange={(e) => { setPhrase(e.target.value); if (error) setError(undefined); }} />
      <Select label="Match" value={mode} options={MODE_OPTIONS} onChange={(e) => setMode(e.target.value as MatchMode)} />
      <div className="sw-filter__edit-actions">
        <Button type="submit">Save</Button>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
