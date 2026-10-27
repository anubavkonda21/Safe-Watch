import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import type { SafetyLoad } from '@/features/upload/SafetyPanel';
import { createVideoDriver } from './driver';
import { PlaybackShell } from './PlaybackShell';

interface PlaybackPanelProps {
  /** The user's own file, played from this browser (it is never uploaded again). Null when it is no longer available. */
  file: File | null;
  mediaId: string;
  safety: SafetyLoad;
}

/**
 * Plays the uploaded video and applies the user's chosen actions to supported findings. Playback is the browser's own
 * <video> on the user's file through an object URL: no server endpoint serves the media, and no path is involved. Everything
 * else (findings, actions, warnings, preferences, feedback) is the shared PlaybackShell.
 */
export function PlaybackPanel({ file, mediaId, safety }: PlaybackPanelProps) {
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bindVideo = useCallback((el: HTMLVideoElement | null) => { videoRef.current = el; setVideo(el); }, []);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [playError, setPlayError] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // An object URL is an external resource: it is created here and revoked in the cleanup, and only then published to state.
    if (!file || typeof URL.createObjectURL !== 'function') return;
    const u = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrl(u); setPlayError(false); setDurationMs(null);
    return () => { URL.revokeObjectURL(u); setUrl(null); };
  }, [file]);

  const driver = useMemo(() => (video ? createVideoDriver(video) : null), [video]);
  const seekToMs = useCallback((ms: number) => { const el = videoRef.current; if (el) el.currentTime = ms / 1000; }, []);
  const playheadMs = useCallback(() => (videoRef.current ? Math.round(videoRef.current.currentTime * 1000) : null), []);

  const player = !file || !url ? (
    <Alert tone="info" title="The video cannot be played here">The file is no longer available in this browser session, so it cannot be played. The findings below are still listed.</Alert>
  ) : (
    // The user's own file: any captions are inside the file and are shown by the player; there is no separate caption track to attach.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      ref={bindVideo} className="sw-player" src={url} controls preload="metadata" playsInline aria-label="Uploaded video preview"
      onLoadedMetadata={(e) => { const d = e.currentTarget.duration; setDurationMs(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null); }}
      onError={() => setPlayError(true)}
    />
  );

  return (
    <PlaybackShell
      mediaId={mediaId} safety={safety} sourceKey={url ?? ''} driver={driver} player={player} durationMs={durationMs}
      seekToMs={video !== null && !playError ? seekToMs : null} playheadMs={playheadMs}
      notice={playError && <Alert tone="warning" title="This browser could not play this file">The format may not be supported here. Findings and actions are listed below, but nothing can be played or acted on.</Alert>}
      footnote={<>
        Actions use the player’s own mute and seek on your file in this browser; the file is not edited or uploaded again. Timing is not sample accurate: each finding says how precise its times are. Only flagged terms in speech and subtitles are supported; nothing else is detected, and unsupported categories never trigger an action. Your choices for each finding are kept for this video only and are not saved; the default action and the warning settings are remembered in this browser.
      </>}
    />
  );
}
