import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import type { SubtitleCue } from '@/domain/extraction/extraction';
import type { ActiveWarning } from '@/domain/warnings/scheduler';
import { analyzeCaptions } from '@/domain/youtube/analysis';
import { describeCaptionRejection, parseCaptionFile } from '@/domain/youtube/captions';
import { describeDiscovery, discoveryOutcome, recordDiscoveries, summarizeDiscoveries } from '@/domain/youtube/discovery';
import { INITIAL_YOUTUBE_STATE, youTubeCapabilities, youTubeSourceReducer, type PlayerErrorKind } from '@/domain/youtube/sourceState';
import { describeRejection, parseYouTubeUrl } from '@/domain/youtube/url';
import { useCustomFilters } from '@/features/filters/filtersStore';
import { usePreferences } from '@/features/preferences/preferencesStore';
import { PlaybackShell } from '@/features/playback/PlaybackShell';
import type { SafetyLoad } from '@/features/upload/SafetyPanel';
import type { YouTubeDriver } from '@/infrastructure/youtube/youtubeDriver';
import { cn } from '@/lib/cn';
import { YouTubePlayer } from './YouTubePlayer';
import { playerErrorCopy, STAGE_LABEL, stageOf } from './youtubeCopy';
import './youtube.css';

const MAX_CAPTION_FILE_BYTES = 2_000_000;

/**
 * YouTube source: paste a link, watch the video in YouTube's own embedded player, and (optionally) add a caption file you already
 * have so SafeWatch can check your phrases against it. The caption file is read in this browser and never sent anywhere; the
 * matching is the same code that checks local files. SafeWatch cannot hear or see an embedded YouTube video, so speech and scene
 * analysis are unavailable here, and the page says so. Mute and skip use the player's own commands, only when the user chooses.
 */
export function YouTubePanel() {
  const urlId = useId();
  const urlHelpId = useId();
  const [state, dispatch] = useReducer(youTubeSourceReducer, INITIAL_YOUTUBE_STATE);
  const [input, setInput] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [driver, setDriver] = useState<YouTubeDriver | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [cues, setCues] = useState<SubtitleCue[] | null>(null);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [safety, setSafety] = useState<SafetyLoad>({ state: 'unavailable' });
  const [known, setKnown] = useState<ReadonlyMap<string, number>>(new Map());
  const filters = useCustomFilters();
  const prefs = usePreferences();
  const fileInput = useRef<HTMLInputElement>(null);
  const driverRef = useRef<YouTubeDriver | null>(null);
  useEffect(() => { driverRef.current = driver; }, [driver]);

  const videoId = state.videoId;

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseYouTubeUrl(input);
    if (!parsed.ok) { setUrlError(describeRejection(parsed.reason)); return; }
    setUrlError(null);
    // A new video never inherits the previous one's captions, findings, discoveries or player.
    setCues(null); setCaptionError(null); setSafety({ state: 'unavailable' }); setKnown(new Map()); setDurationMs(null);
    dispatch({ type: 'validated', videoId: parsed.videoId });
    setNonce((n) => n + 1);
  }

  function clearSource() {
    dispatch({ type: 'reset' });
    setCues(null); setCaptionError(null); setSafety({ state: 'unavailable' }); setKnown(new Map()); setDurationMs(null); setUrlError(null);
  }

  async function onCaptionFile(file: File | undefined) {
    if (!file) return;
    setCaptionError(null);
    if (file.size > MAX_CAPTION_FILE_BYTES) { setCaptionError(describeCaptionRejection('too-large')); return; }
    let text: string;
    try { text = await file.text(); } catch { setCaptionError('The file could not be read.'); return; }
    const parsed = parseCaptionFile(text);
    if (!parsed.ok) { setCaptionError(describeCaptionRejection(parsed.reason)); return; }
    setKnown(new Map());
    setCues(parsed.cues);
    dispatch({ type: 'captions-added', captions: { fileName: file.name.slice(0, 120), format: parsed.format, cueCount: parsed.cues.length, firstStartSeconds: parsed.firstStartSeconds, lastEndSeconds: parsed.lastEndSeconds } });
  }

  function removeCaptions() {
    setCues(null); setSafety({ state: 'unavailable' }); setKnown(new Map());
    dispatch({ type: 'captions-removed' });
  }

  // Keep the duration up to date from the player (it is only known once the player has loaded the video).
  useEffect(() => {
    if (!driver) return;
    const read = () => { const d = driver.surface.durationMs; setDurationMs((prev) => (prev === d ? prev : d)); };
    read();
    return driver.listen(read);
  }, [driver]);

  // The analysis: pure and local, so it simply re-runs whenever the captions, the phrase list or the video's length change.
  useEffect(() => {
    if (!videoId || !cues) return;
    let cancelled = false;
    dispatch({ type: 'analysis-started' });
    analyzeCaptions({ videoId, cues, terms: filters, durationMs })
      .then((analysis) => {
        if (cancelled) return;
        // Findings seen for the first time are stamped with where playback is NOW, so late and missed ones can be told apart.
        const at = driverRef.current ? driverRef.current.surface.currentTimeMs : 0;
        setKnown((prev) => recordDiscoveries(prev, analysis.findings, at));
        setSafety({ state: 'ready', analysis });
        dispatch({ type: 'analysis-finished' });
      })
      .catch(() => { if (!cancelled) { setSafety({ state: 'unavailable' }); dispatch({ type: 'analysis-failed' }); } });
    return () => { cancelled = true; };
  }, [videoId, cues, filters, durationMs]);

  const onLoading = useCallback(() => dispatch({ type: 'player-loading' }), []);
  const onReady = useCallback(() => dispatch({ type: 'player-ready' }), []);
  const onError = useCallback((kind: PlayerErrorKind) => dispatch({ type: 'player-error', kind }), []);
  const onDriver = useCallback((d: YouTubeDriver | null) => setDriver(d), []);

  const leadMs = prefs.leadSeconds * 1000;
  const findings = safety.state === 'ready' ? safety.analysis.findings : [];
  const discoveryNote = describeDiscovery(summarizeDiscoveries(known, findings, leadMs), prefs.leadSeconds);
  const warningNote = useCallback((w: ActiveWarning): string | null => {
    const late = w.group.members.some((m) => { const at = known.get(m.overrideKey); return at !== undefined && discoveryOutcome(w.group.startMs, at, leadMs) === 'late'; });
    return late ? 'Found late: the captions were checked when playback was already close to this.' : null;
  }, [known, leadMs]);

  const capabilities = useMemo(() => youTubeCapabilities(state), [state]);
  const stage = stageOf(state);
  const playerReady = state.player === 'player-ready' && driver !== null;
  const seekToMs = useMemo(() => (playerReady && driver ? (ms: number) => driver.seekToMs(ms) : null), [playerReady, driver]);
  const playheadMs = useCallback(() => (driverRef.current ? driverRef.current.surface.currentTimeMs : null), []);

  return (
    <div className="sw-yt-panel" data-testid="youtube-panel">
      <Badge tone="neutral">Early preview</Badge>
      <h3 className="sw-h3">Watch a YouTube video</h3>
      <p className="sw-body-sm sw-muted">Paste a YouTube link to watch it here in YouTube’s own player. SafeWatch can check your phrases against a caption file you provide. It cannot hear or see an embedded YouTube video.</p>

      <form className="sw-yt-form" onSubmit={submit} noValidate>
        <label htmlFor={urlId} className="sw-label">YouTube link</label>
        <div className="sw-yt-form__row">
          <input
            id={urlId} className="sw-input" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://www.youtube.com/watch?v=…"
            value={input} onChange={(e) => setInput(e.target.value)} aria-invalid={urlError ? true : undefined} aria-describedby={urlError ? `${urlHelpId} ${urlId}-err` : urlHelpId} maxLength={2048}
          />
          <Button type="submit">Load video</Button>
        </div>
        <p id={urlHelpId} className="sw-caption sw-muted">Watch links, youtu.be links and Shorts links are supported. Playlists, channels and live pages are not.</p>
        {urlError && <p id={`${urlId}-err`} className="sw-caption sw-yt-error" role="alert">{urlError}</p>}
      </form>

      <p className="sw-caption sw-muted sw-yt-disclosure">
        Loading a video contacts YouTube (youtube.com for its player code, youtube-nocookie.com for the player itself). YouTube then receives the usual player information, such as your IP address and browser details, under its own terms and privacy policy. Nothing is requested from YouTube until you press Load video, and the video does not start by itself. Your phrases, your caption file and any findings are not sent to YouTube or to anyone else.
      </p>

      {videoId && (
        <>
          <ol className="sw-yt-stages" aria-label="Progress">
            {(['source', 'player', 'captions', 'analysis'] as const).map((k) => (
              <li key={k} className={cn('sw-yt-stage', `is-${stage[k].tone}`)}>
                <span className="sw-caption sw-muted">{STAGE_LABEL[k]}</span>
                <span className="sw-body-sm">{stage[k].text}</span>
              </li>
            ))}
          </ol>
          <p className="sw-sr-only" role="status" aria-live="polite">{stage.player.text}. {stage.analysis.text}</p>

          {state.player === 'player-error' && state.playerError && (
            <Alert tone="warning" title={playerErrorCopy(state.playerError).title}>
              {playerErrorCopy(state.playerError).body}
              <span className="sw-yt-alert-actions"><Button variant="secondary" onClick={() => { dispatch({ type: 'validated', videoId }); setNonce((n) => n + 1); }}>Try again</Button></span>
            </Alert>
          )}

          <PlaybackShell
            key={`${videoId}-${nonce}`}
            mediaId={`yt-${videoId}`} safety={safety} sourceKey={`${videoId}-${nonce}`} driver={driver}
            label="YouTube player and actions" durationMs={durationMs} seekToMs={seekToMs} playheadMs={playheadMs}
            player={<YouTubePlayer videoId={videoId} onLoading={onLoading} onDriver={onDriver} onReady={onReady} onError={onError} />}
            banner={discoveryNote ? <p className="sw-body-sm sw-yt-discovery" role="status">{discoveryNote}</p> : null}
            warningNote={warningNote}
            statusNote={safety.state === 'ready' ? undefined : state.captions ? 'Checking your captions…' : 'No analysis yet: SafeWatch has no captions for this video. Add a caption file below, or use a local file.'}
            footnote={<>
              Mute and skip use the YouTube player’s own commands and happen only when you choose them. Muting silences the whole player; the video and its sound are not edited, copied or stored. Timing follows your caption file and the player’s time readings, and is not sample accurate. Only flagged terms in captions are checked; nothing in the picture or the spoken audio is analysed, and scene categories are not supported. Your choices for each finding are kept for this video only.
            </>}
          />

          <section className="sw-yt-captions" aria-label="Captions for phrase checking">
            <p className="sw-label sw-muted">Captions for phrase checking</p>
            {state.captions ? (
              <>
                <p className="sw-body-sm">
                  <strong>{state.captions.fileName}</strong>: {state.captions.cueCount} captions ({state.captions.format.toUpperCase()}), {Math.round(state.captions.firstStartSeconds)} s to {Math.round(state.captions.lastEndSeconds)} s. Read in this browser only.
                </p>
                <Button variant="secondary" onClick={removeCaptions}>Remove captions</Button>
              </>
            ) : (
              <>
                <p className="sw-caption sw-muted">SafeWatch cannot get captions from YouTube: YouTube only gives caption files to a video’s owner. If you have an SRT or WebVTT file for this video (for example, you own it, or the creator shared it), add it to check your phrases. Add it before you press play so warnings can come in time.</p>
                <input ref={fileInput} type="file" className="sw-sr-only" tabIndex={-1} aria-label="Caption file (SRT or WebVTT)" accept=".srt,.vtt,text/vtt,application/x-subrip" onChange={(e) => { void onCaptionFile(e.target.files?.[0]); e.target.value = ''; }} />
                <Button variant="secondary" onClick={() => fileInput.current?.click()}>Add caption file (.srt or .vtt)</Button>
              </>
            )}
            {captionError && <p className="sw-caption sw-yt-error" role="alert">{captionError}</p>}
            <p className="sw-caption sw-muted">The file may be incomplete or may not match this video; SafeWatch cannot check. Findings are only as good as the file. No speech is recognised for YouTube videos.</p>
          </section>

          <section className="sw-yt-caps" aria-label="What can be checked for this source">
            <p className="sw-label sw-muted">What can be checked for this video</p>
            <ul className="sw-yt-caps__list">
              {capabilities.map((c) => (
                <li key={c.id} className="sw-yt-cap">
                  <span className="sw-body-sm sw-yt-cap__name">{c.label}</span>
                  <Badge tone={c.status === 'available' ? 'success' : 'neutral'}>{c.status === 'available' ? 'Available' : c.status === 'unsupported' ? 'Not supported' : 'Unavailable'}</Badge>
                  <p className="sw-caption sw-muted"><strong>Source:</strong> {c.source}. <strong>Limits:</strong> {c.limits}</p>
                </li>
              ))}
            </ul>
            <p className="sw-caption sw-muted">A result with no findings only means none of your phrases were in the captions you gave: it does not mean the video is suitable. For speech, upload the video file you own with the local file option.</p>
          </section>

          <Button variant="ghost" onClick={clearSource}>Stop and clear this video</Button>
        </>
      )}
    </div>
  );
}
