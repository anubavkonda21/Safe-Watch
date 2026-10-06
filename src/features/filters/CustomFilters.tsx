import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Container } from '@/components/ui/Container';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { CloseIcon } from '@/components/ui/icons';
import { MATCH_MODES, MATCH_MODE_LABEL, MAX_PHRASE_LENGTH, type FilterRejection, type MatchMode } from '@/domain/text/customFilter';
import { cn } from '@/lib/cn';
import { filtersStore, useCustomFilters } from './filtersStore';
import './filters.css';

const REJECTION_COPY: Record<FilterRejection, string> = {
  empty: 'Enter a word or phrase.',
  'too-long': `Keep it under ${MAX_PHRASE_LENGTH} characters.`,
  'no-words': 'Include at least one letter or number.',
  duplicate: 'You already have that filter.',
  'limit-reached': 'You have reached the maximum number of filters. Remove one to add another.',
};

const MODE_OPTIONS = MATCH_MODES.map((m) => ({ value: m, label: MATCH_MODE_LABEL[m] }));
const MODE_HELP: Record<MatchMode, string> = {
  'word-boundary': 'Matches the whole word only: “art” does not match “party”.',
  phrase: 'Whole words, ignoring spacing and punctuation: “SafeWatch” also matches “safe watch”.',
  'case-insensitive': 'Matches anywhere in the text, even inside longer words, ignoring capitals.',
  exact: 'Matches anywhere in the text, capitals must be identical.',
};

/** "Custom filters": choose words or phrases SafeWatch should DETECT. Detection only: nothing is muted, hidden or changed. */
export function CustomFiltersSection() {
  const filters = useCustomFilters();
  const [phrase, setPhrase] = useState('');
  const [mode, setMode] = useState<MatchMode>('word-boundary');
  const [error, setError] = useState<string | undefined>();

  function submit(e: FormEvent) {
    e.preventDefault();
    const result = filtersStore.add(phrase, mode);
    if (!result.ok) { setError(REJECTION_COPY[result.reason]); return; }
    setError(undefined);
    setPhrase('');
  }

  return (
    <section id="filters" className="sw-section" aria-labelledby="filters-title">
      <Container>
        <div className="sw-section__head">
          <Badge>Early preview</Badge>
          <h2 id="filters-title" className="sw-h1">Custom filters</h2>
          <p className="sw-body-lg sw-muted">Choose words or phrases SafeWatch should detect.</p>
        </div>

        <div className="sw-filters">
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
            <p className="sw-body-sm sw-muted sw-filters__empty">No filters yet. Matches appear in the transcript once a video has been prepared.</p>
          ) : (
            <ul className="sw-filters__list" aria-label="Your filters">
              {filters.map((f) => (
                <li key={f.id} className={cn('sw-filter', !f.enabled && 'is-off')}>
                  <div className="sw-filter__text">
                    <span className="sw-filter__phrase">{f.phrase}</span>
                    <span className="sw-caption sw-muted">{MATCH_MODE_LABEL[f.matchMode]}</span>
                  </div>
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
                </li>
              ))}
            </ul>
          )}
          <p className="sw-caption sw-muted sw-filters__note">Filters stay in this browser. SafeWatch only reports where they occur; it does not mute, hide or change your video.</p>
        </div>
      </Container>
    </section>
  );
}
