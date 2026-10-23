import type { FocusEvent, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { CloseIcon } from '@/components/ui/icons';
import type { ActiveWarning } from '@/domain/warnings/scheduler';

interface Props {
  warning: ActiveWarning;
  /** How long it stays when untouched (for the lifetime indicator). */
  durationMs: number;
  onSkip: () => void;
  onIgnore: () => void;
  onDismiss: () => void;
  onHold: () => void;
  onRelease: () => void;
}

export const warningTitle = (w: ActiveWarning): string => {
  const n = w.group.members.length;
  if (n > 1) return `${n} flagged phrases are coming up.`;
  return w.group.members[0]?.uncertain ? 'A possible flagged phrase is coming up.' : 'A flagged phrase is coming up.';
};

export const warningWhen = (w: ActiveWarning): string => {
  const s = Math.round(w.startsInMs / 1000);
  return s <= 1 ? 'Starting now.' : `Starts in about ${s} seconds.`;
};

/** The user's own phrases, as they typed them (plain text), at most two, then a count. */
export const warningPhrases = (w: ActiveWarning): string => {
  const terms = [...new Set(w.group.members.map((m) => m.term).filter((t): t is string => !!t))];
  const shown = terms.slice(0, 2).map((t) => `“${t}”`).join(', ');
  return terms.length > 2 ? `${shown} and ${terms.length - 2} more` : shown;
};

const planOf = (w: ActiveWarning): string | null => {
  const choices = new Set(w.group.members.map((m) => m.choice));
  if (choices.size !== 1) return choices.size > 1 ? 'You have set different actions for these.' : null;
  const only = [...choices][0];
  return only === 'mute' ? 'Currently set to mute.' : only === 'skip' ? 'Currently set to skip.' : null;
};

/**
 * A compact heads-up about an upcoming flagged phrase. It is information with two clear choices: Skip and Ignore apply the
 * same CP8 choices as the list below. Expiring or being dismissed does nothing to playback and is not consent. It is not a
 * judgement, shows no score or confidence, and never takes focus from the player.
 */
export function UpcomingWarning({ warning, durationMs, onSkip, onIgnore, onDismiss, onHold, onRelease }: Props) {
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onDismiss(); } };
  // Keep it while the pointer or keyboard focus is on it (users need time to act); resume when both have left.
  const leave = (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onRelease(); };
  const plan = planOf(warning);
  return (
    <div className="sw-warn" role="group" aria-label="Upcoming flagged phrase" onMouseEnter={onHold} onMouseLeave={onRelease} onFocus={onHold} onBlur={leave}>
      <div className="sw-warn__body">
        <p className="sw-body-sm sw-warn__title">{warningTitle(warning)}</p>
        <p className="sw-caption sw-muted sw-warn__detail">{warningPhrases(warning)} {warningWhen(warning)}{plan ? ` ${plan}` : ''}</p>
      </div>
      <div className="sw-warn__actions">
        <Button onClick={onSkip} onKeyDown={key}>Skip</Button>
        <Button variant="secondary" onClick={onIgnore} onKeyDown={key}>Ignore</Button>
        <IconButton label="Dismiss warning" onClick={onDismiss} onKeyDown={key}><CloseIcon size={16} /></IconButton>
      </div>
      <span className="sw-warn__bar" style={{ animationDuration: `${durationMs}ms` }} aria-hidden="true" />
    </div>
  );
}
