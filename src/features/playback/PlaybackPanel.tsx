import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { actionsOf, resolveViews, INITIAL_SETTINGS, type ActionChoice, type FindingActionView } from '@/domain/playback/actions';
import type { CoordinatorEvent } from '@/domain/playback/coordinator';
import { planCandidates } from '@/domain/playback/planning';
import { categoryById } from '@/domain/safety/taxonomy';
import type { SafetyLoad } from '@/features/upload/SafetyPanel';
import { cn } from '@/lib/cn';
import { settingsReducer } from './actionSettings';
import { analysisNote, eventText, range, TIMING_LABEL, unavailableText } from './playbackCopy';
import { usePlaybackCoordinator } from './usePlaybackCoordinator';

const CHOICES: Array<{ value: ActionChoice; label: string }> = [
  { value: 'none', label: 'No action' }, { value: 'mute', label: 'Mute' }, { value: 'skip', label: 'Skip' }, { value: 'ignore', label: 'Ignore' },
];

interface PlaybackPanelProps {
  /** The user's own file, played from this browser (it is never uploaded again). Null when it is no longer available. */
  file: File | null;
  mediaId: string;
  safety: SafetyLoad;
}

/**
 * Plays the uploaded video and applies the user's chosen actions to supported findings. Playback is the browser's own
 * <video> on the user's file through an object URL: no server endpoint serves the media, and no path is involved.
 *
 * Only findings of the implemented category (flagged terms in speech and subtitles) can have an action. Nothing is acted
 * on until the user chooses (the default is no action), uncertain and unavailable findings are never acted on by default,
 * and the master switch and every per-finding choice take effect immediately. Choices are kept in memory for this video only:
 * not persisted and not sent anywhere.
 */
export function PlaybackPanel({ file, mediaId, safety }: PlaybackPanelProps) {
  const [settings, dispatch] = useReducer(settingsReducer, INITIAL_SETTINGS);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bindVideo = useCallback((el: HTMLVideoElement | null) => { videoRef.current = el; setVideo(el); }, []);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [playError, setPlayError] = useState(false);
  const [failed, setFailed] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [url, setUrl] = useState<string | null>(null);
  const analysis = safety.state === 'ready' ? safety.analysis : null;

  useEffect(() => {
    // An object URL is an external resource: it is created here and revoked in the cleanup, and only then published to state.
    if (!file || typeof URL.createObjectURL !== 'function') return;
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(u); setPlayError(false); setDurationMs(null);
    return () => { URL.revokeObjectURL(u); setUrl(null); };
  }, [file]);

  const candidates = useMemo(() => planCandidates({ mediaId, analysis, durationMs }), [mediaId, analysis, durationMs]);
  const views = useMemo(() => resolveViews(candidates, failed ? { ...settings, autoEnabled: false } : settings), [candidates, settings, failed]);
  const actions = useMemo(() => actionsOf(views), [views]);
  const termByFinding = useMemo(() => new Map(candidates.map((c) => [c.findingId, c.term])), [candidates]);

  const onEvent = useCallback((e: CoordinatorEvent) => { setAnnouncement(eventText(e, (id) => termByFinding.get(id) ?? null)); }, [termByFinding]);
  const onFailure = useCallback(() => { setFailed(true); setAnnouncement('Automatic actions stopped because of an error. Playback and your sound are not affected.'); }, []);
  usePlaybackCoordinator({ video, sourceKey: url ?? '', actions, autoEnabled: settings.autoEnabled && !failed, onEvent, onFailure });

  const note = analysisNote(safety, candidates);
  const jump = (v: FindingActionView) => { const el = videoRef.current; if (el) el.currentTime = Math.max(0, v.candidate.startMs - 1500) / 1000; };

  return (
    <section className="sw-playback" aria-label="Playback">
      <p className="sw-label sw-muted">Playback and actions</p>
      {!file || !url ? (
        <Alert tone="info" title="The video cannot be played here">The file is no longer available in this browser session, so it cannot be played. The findings below are still listed.</Alert>
      ) : (
        // The user's own file: any captions are inside the file and are shown by the player; there is no separate caption track to attach.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          ref={bindVideo} className="sw-player" src={url} controls preload="metadata" playsInline aria-label="Uploaded video preview"
          onLoadedMetadata={(e) => { const d = e.currentTarget.duration; setDurationMs(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null); }}
          onError={() => setPlayError(true)}
        />
      )}
      {playError && <Alert tone="warning" title="This browser could not play this file">The format may not be supported here. Findings and actions are listed below, but nothing can be played or acted on.</Alert>}

      <div className="sw-pcontrols">
        <label className="sw-pswitch">
          <input type="checkbox" role="switch" checked={settings.autoEnabled && !failed} disabled={failed} onChange={(e) => dispatch({ type: 'master', enabled: e.target.checked })} />
          <span className="sw-body-sm">Automatic actions</span>
        </label>
        <label className="sw-pselect">
          <span className="sw-caption sw-muted">Default for flagged terms</span>
          <select className="sw-select" value={settings.defaultChoice} onChange={(e) => dispatch({ type: 'default', choice: e.target.value as 'none' | 'mute' | 'skip' })}>
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
          {views.map((v) => <Row key={v.candidate.id} v={v} onChoose={(choice) => dispatch({ type: 'choose', key: v.candidate.overrideKey, choice })} onClear={() => dispatch({ type: 'clear', key: v.candidate.overrideKey })} onJump={() => jump(v)} canJump={video !== null && !playError} />)}
        </ul>
      )}

      <p className="sw-caption sw-muted">
        Actions use the player’s own mute and seek on your file in this browser; the file is not edited or uploaded again. Timing is not sample accurate: each finding says how precise its times are. Only flagged terms in speech and subtitles are supported; nothing else is detected, and unsupported categories never trigger an action. Your choices are kept for this video only and are not saved.
      </p>
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
