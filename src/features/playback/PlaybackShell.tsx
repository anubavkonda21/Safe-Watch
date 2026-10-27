import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { actionsOf, resolveViews, INITIAL_SETTINGS, type ActionChoice, type FindingActionView } from '@/domain/playback/actions';
import type { CoordinatorEvent } from '@/domain/playback/coordinator';
import { planCandidates } from '@/domain/playback/planning';
import { forwardTarget, SKIP_FORWARD_MS } from '@/domain/playback/seekForward';
import { formatTimecode } from '@/domain/media/format';
import { buildWarningGroups } from '@/domain/warnings/groups';
import type { ActiveWarning, WarningEvent } from '@/domain/warnings/scheduler';
import { FeedbackPanel } from '@/features/feedback/FeedbackPanel';
import { newSessionId } from '@/features/feedback/feedbackStore';
import { preferencesStore, usePreferences } from '@/features/preferences/preferencesStore';
import { categoryById } from '@/domain/safety/taxonomy';
import type { SafetyLoad } from '@/features/upload/SafetyPanel';
import { cn } from '@/lib/cn';
import { settingsReducer } from './actionSettings';
import type { PlaybackDriver } from './driver';
import { analysisNote, eventText, range, TIMING_LABEL, unavailableText } from './playbackCopy';
import { PlaybackPreferences } from './PlaybackPreferences';
import { UpcomingWarning, warningPhrases, warningTitle, warningWhen } from './UpcomingWarning';
import { usePlaybackCoordinator } from './usePlaybackCoordinator';

const CHOICES: Array<{ value: ActionChoice; label: string }> = [
  { value: 'none', label: 'No action' }, { value: 'mute', label: 'Mute' }, { value: 'skip', label: 'Skip' }, { value: 'ignore', label: 'Ignore' },
];

export interface PlaybackShellProps {
  mediaId: string;
  safety: SafetyLoad;
  /** Changes when the source changes: everything the shell applied to the old source (warnings, actions) is dropped. */
  sourceKey: string;
  /** The player behind the coordinator and the warning scheduler; null while there is none. */
  driver: PlaybackDriver | null;
  /** The visible player (a video element, or the YouTube player container). Rendered where the picture belongs. */
  player: ReactNode;
  /** Alerts about the player itself (cannot play, cannot load). */
  notice?: ReactNode;
  /** Shown between the player and the controls: for example how late findings were handled. */
  banner?: ReactNode;
  durationMs: number | null;
  /** Moves the playhead, or null when the player cannot be moved. */
  seekToMs: ((ms: number) => void) | null;
  playheadMs: () => number | null;
  /** Source-specific explanation printed under the controls. */
  footnote: ReactNode;
  /** Extra sentence for a warning (for example "found after playback had started"); null for none. */
  warningNote?: (w: ActiveWarning) => string | null;
  /** Replaces the default one-line status of the analysis (undefined keeps the default; null shows none). */
  statusNote?: string | null;
  label?: string;
}

/**
 * The part of the playback experience that does not depend on WHERE the media plays: findings and their actions, the master
 * switch, the heads-up warning, preferences and the missed-finding report. It is driven by a PlaybackDriver, so the same
 * coordinator and warning scheduler serve a local file and a YouTube video. Behaviour is the CP8/CP9 behaviour, unchanged.
 *
 * Only findings of the implemented category (flagged terms) can have an action. Nothing is acted on until the user chooses (the
 * default is no action), uncertain and unavailable findings are never acted on by default, and the master switch and every
 * per-finding choice take effect immediately. Choices are kept in memory for this video only.
 */
export function PlaybackShell({ mediaId, safety, sourceKey, driver, player, notice, banner, durationMs, seekToMs, playheadMs, footnote, warningNote, statusNote, label = 'Playback and actions' }: PlaybackShellProps) {
  const prefs = usePreferences();
  // The default action is a remembered preference; everything else (master switch, per-finding choices) belongs to this video only.
  const [settings, dispatch] = useReducer(settingsReducer, undefined, () => ({ ...INITIAL_SETTINGS, defaultChoice: preferencesStore.getSnapshot().defaultAction }));
  const [session] = useState(newSessionId);
  const [activeWarning, setActiveWarning] = useState<ActiveWarning | null>(null);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const analysis = safety.state === 'ready' ? safety.analysis : null;

  const candidates = useMemo(() => planCandidates({ mediaId, analysis, durationMs }), [mediaId, analysis, durationMs]);
  const views = useMemo(() => resolveViews(candidates, failed ? { ...settings, autoEnabled: false } : settings), [candidates, settings, failed]);
  const actions = useMemo(() => actionsOf(views), [views]);
  const termByFinding = useMemo(() => new Map(candidates.map((c) => [c.findingId, c.term])), [candidates]);

  const groups = useMemo(() => buildWarningGroups(views), [views]);
  const warningSettings = useMemo(() => ({ enabled: prefs.warningsEnabled && !failed, leadMs: prefs.leadSeconds * 1000, durationMs: prefs.durationSeconds * 1000 }), [prefs.warningsEnabled, prefs.leadSeconds, prefs.durationSeconds, failed]);
  const onWarning = useCallback((e: WarningEvent) => {
    if (e.type === 'show') { setActiveWarning(e.warning); setAnnouncement(`${warningTitle(e.warning)} ${warningPhrases(e.warning)} ${warningWhen(e.warning)}`.replace(/\s+/g, ' ')); } else setActiveWarning((cur) => (cur?.id === e.id ? null : cur));
  }, []);
  useEffect(() => { setActiveWarning(null); }, [sourceKey]); // eslint-disable-line react-hooks/set-state-in-effect -- a different video never inherits a warning

  const onEvent = useCallback((e: CoordinatorEvent) => { setAnnouncement(eventText(e, (id) => termByFinding.get(id) ?? null)); }, [termByFinding]);
  const onFailure = useCallback(() => { setFailed(true); setAnnouncement('Automatic actions stopped because of an error. Playback and your sound are not affected.'); }, []);
  const warning = useMemo(() => ({ groups, settings: warningSettings, onEvent: onWarning }), [groups, warningSettings, onWarning]);
  const controls = usePlaybackCoordinator({ driver, sourceKey, actions, autoEnabled: settings.autoEnabled && !failed, onEvent, onFailure, warning });

  /** Skip and Ignore on a warning are the CP8 choices for the findings it covers, applied once; the warning then goes away. */
  const applyFromWarning = (w: ActiveWarning, choice: 'skip' | 'ignore') => {
    for (const m of w.group.members) dispatch({ type: 'choose', key: m.overrideKey, choice });
    controls.resolve();
    setAnnouncement(choice === 'skip' ? `Set to skip ${warningPhrases(w)}. It will be skipped when playback reaches it.` : `Ignored ${warningPhrases(w)}. You can undo this in the list below.`);
  };
  const chooseDefault = (choice: 'none' | 'mute' | 'skip') => { preferencesStore.update({ defaultAction: choice }); dispatch({ type: 'default', choice }); };
  const slot = warningSettings.enabled && settings.autoEnabled && groups.length > 0;

  const note = statusNote === undefined ? analysisNote(safety, candidates) : statusNote;
  const jump = (v: FindingActionView) => { seekToMs?.(Math.max(0, v.candidate.startMs - 1500)); };
  /**
   * "+10 s": the viewer's own jump forward, independent of any finding. It is a seek the USER makes, so the coordinator treats it
   * like any other user seek (a jump into a skip span is respected, nothing is muted or skipped on the viewer's behalf), and the
   * warning scheduler simply re-reads the position. It never goes backward and never past the end.
   */
  const skipForward = () => {
    if (!seekToMs) return;
    const target = forwardTarget(playheadMs(), durationMs);
    if (!target) { setAnnouncement('The player has not said where it is yet, so it cannot skip forward.'); return; }
    if (!target.moved) { setAnnouncement('Already at the end of the video.'); return; }
    seekToMs(target.targetMs);
    setAnnouncement(`Skipped forward ${SKIP_FORWARD_MS / 1000} seconds, to ${formatTimecode(target.targetMs / 1000)}.`);
  };

  return (
    <section className="sw-playback" aria-label="Playback">
      <p className="sw-label sw-muted">{label}</p>
      {player}
      <div className="sw-pseek">
        <Button variant="secondary" onClick={skipForward} disabled={seekToMs === null} aria-label={`Skip forward ${SKIP_FORWARD_MS / 1000} seconds`}>+{SKIP_FORWARD_MS / 1000} s</Button>
        {seekToMs === null && <span className="sw-caption sw-muted">Available once the player is ready.</span>}
      </div>
      {slot && (
        // A fixed-height place under the player: a warning appears here instead of over the picture, the captions or the controls, and the layout never jumps.
        <div className="sw-warnslot">
          {activeWarning ? (
            <UpcomingWarning
              warning={activeWarning} durationMs={warningSettings.durationMs}
              onSkip={() => applyFromWarning(activeWarning, 'skip')} onIgnore={() => applyFromWarning(activeWarning, 'ignore')}
              note={warningNote?.(activeWarning) ?? null}
              onDismiss={() => controls.dismiss()} onHold={controls.hold} onRelease={controls.release}
            />
          ) : (
            <p className="sw-caption sw-muted sw-warnslot__hint">A heads-up appears here {prefs.leadSeconds} seconds before a flagged phrase.</p>
          )}
        </div>
      )}
      {notice}
      {banner}

      <div className="sw-pcontrols">
        <label className="sw-pswitch">
          <input type="checkbox" role="switch" checked={settings.autoEnabled && !failed} disabled={failed} onChange={(e) => dispatch({ type: 'master', enabled: e.target.checked })} />
          <span className="sw-body-sm">Automatic actions</span>
        </label>
        <label className="sw-pselect">
          <span className="sw-caption sw-muted">Default for flagged terms</span>
          <select className="sw-select" value={settings.defaultChoice} onChange={(e) => chooseDefault(e.target.value as 'none' | 'mute' | 'skip')}>
            <option value="none">No action</option><option value="mute">Mute</option><option value="skip">Skip</option>
          </select>
        </label>
      </div>
      <p className="sw-caption sw-muted">
        {failed ? 'Automatic actions are off because of an error.' : settings.autoEnabled ? 'Automatic actions are on: the actions you choose below happen while you watch.' : 'Automatic actions are off: the video plays normally and your sound is untouched.'}
      </p>

      <p className="sw-caption sw-pstatus" role="status" aria-live="polite">{announcement}</p>
      {note && <p className="sw-body-sm sw-muted">{note}</p>}

      {candidates.length > 0 && (
        <ul className="sw-pfindings" aria-label="Findings and actions">
          {views.map((v) => <Row key={v.candidate.id} v={v} onChoose={(choice) => dispatch({ type: 'choose', key: v.candidate.overrideKey, choice })} onClear={() => dispatch({ type: 'clear', key: v.candidate.overrideKey })} onJump={() => jump(v)} canJump={seekToMs !== null} />)}
        </ul>
      )}

      {candidates.length > 0 && (
        <details className="sw-details">
          <summary className="sw-caption">Why can a finding be unavailable for actions?</summary>
          <div className="sw-details__body">
            <p className="sw-caption sw-muted">A finding gets no automatic action when its timing cannot be trusted: it has no duration (a word without an end time), it lies outside the video, its details are not valid, or its category is not supported. It is still listed, and the absence of an action does not mean it is unimportant.</p>
          </div>
        </details>
      )}
      <PlaybackPreferences />
      <FeedbackPanel session={session} durationMs={durationMs} playheadMs={playheadMs} />

      <p className="sw-caption sw-muted">{footnote}</p>
    </section>
  );
}

function Row({ v, onChoose, onClear, onJump, canJump }: { v: FindingActionView; onChoose: (c: ActionChoice) => void; onClear: () => void; onJump: () => void; canJump: boolean }) {
  const c = v.candidate;
  const unavailable = v.state === 'unavailable';
  const label = `Action for the finding at ${range({ startMs: c.findingStartMs, endMs: c.findingEndMs })}`;
  return (
    <li className={cn('sw-prow', `is-${v.state}`)}>
      <div className="sw-prow__head">
        <span className="sw-caption sw-prow__time">{range(c)}</span>
        <span className="sw-prow__tags">
          <Badge tone="neutral">{categoryById(c.category).label}</Badge>
          <Badge tone={c.findingStatus === 'detected' ? 'accent' : 'warning'}>{c.findingStatus === 'detected' ? 'Detected' : 'Uncertain'}</Badge>
          <Badge tone="neutral">{TIMING_LABEL[c.timing.quality]}</Badge>
        </span>
        {c.term && <span className="sw-body-sm sw-prow__term">“{c.term}”</span>}
      </div>
      {unavailable ? (
        <p className="sw-caption sw-muted">{unavailableText(c.unavailableReason)}</p>
      ) : (
        <div className="sw-prow__controls">
          <label className="sw-pselect">
            <span className="sw-sr-only">{label}</span>
            <select className="sw-select" aria-label={label} value={v.choice} onChange={(e) => onChoose(e.target.value as ActionChoice)}>
              {CHOICES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <span className="sw-caption" data-testid="action-state">{stateText(v)}</span>
          {v.state === 'ignored' && <Button variant="secondary" onClick={onClear}>Undo ignore</Button>}
          <Button variant="secondary" onClick={onJump} disabled={!canJump}>Play from just before</Button>
        </div>
      )}
      {c.findingStatus === 'uncertain' && !unavailable && <p className="sw-caption sw-muted">This finding is uncertain, so it is never acted on unless you choose an action for it.</p>}
      <details className="sw-details">
        <summary className="sw-caption">Why and how the interval was set</summary>
        <div className="sw-details__body">
          <p className="sw-caption">{v.action ? v.action.reason : `Finding ${c.findingId}: the term “${c.term ?? ''}” occurs here. ${c.timing.note}`}</p>
          <p className="sw-caption sw-muted">Finding interval {range({ startMs: c.findingStartMs, endMs: c.findingEndMs })}. Action interval {range(c)}.</p>
        </div>
      </details>
    </li>
  );
}

function stateText(v: FindingActionView): string {
  switch (v.state) {
    case 'enabled': return v.choice === 'mute' ? 'Will mute this part' : 'Will skip this part';
    case 'off': return `${v.choice === 'mute' ? 'Mute' : 'Skip'} chosen, but automatic actions are off`;
    case 'ignored': return 'Ignored';
    case 'none': return 'No action';
    case 'unavailable': return '';
  }
}
