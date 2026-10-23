# CHECKPOINT 8 REPORT: Playback Safety Actions

**Only findings that exist today (flagged terms in speech and subtitles) can trigger an action. Nothing is acted on until the user chooses. This checkpoint adds no detection, no new category and no server behaviour; it does not enable visual safety detection or complete video censorship. The media file is never edited.**

## 1. What was built

- `src/domain/playback`: planning (`planCandidates`: availability, timing quality, margin, clamp), choices (`resolveViews`, `buildSpans`, `spanAt`, `nextEdgeMs`) and the `PlaybackCoordinator` behind a small `PlaybackSurface` interface.
- `src/features/playback`: `VideoSurface` (the only seconds to milliseconds conversion), `usePlaybackCoordinator` (events, boundary timers, animation frames, failure isolation), the settings reducer and `PlaybackPanel` (player, master switch, default action, per-finding choices, undo ignore, explanation, live announcements).
- `useMediaIngestion` keeps the user's `File` in memory for playback; `SafetyPanel` reports its result so the playback panel uses the same findings without another request.
- `npm run check:playback`.

## 2. Playback source (discovered)

No player and no media endpoint existed. The smallest safe integration is the browser's `<video>` on the user's own `File` through an object URL: no endpoint, path or upload was added, nothing is served. Container and codec support is the browser's; an unplayable file is reported. A media endpoint would be a security decision (bearer-token ids) for the hardening checkpoint.

## 3. Actions and timestamps

`mute` (the `muted` flag only while inside the interval; volume never touched; the user's own mute restored; an unmute by the user respected), `skip` (once, to the interval end, capped at the duration, strictly forward, 3 retries, user seeks into the interval respected, replay skips again), `ignore` (undoable), `none` (default). Skip wins over mute where they overlap; overlapping and adjacent actions merge, keeping every source finding.

Intervals are integer milliseconds, half-open. Precision is taken from the CP7 finding: word-timed speech (start about 0.1 s, end approximate) gets a margin of 150 ms before and 250 ms after; a subtitle cue is exact but the whole line; speech without word timing is the whole segment. Unavailable (never acted on, never repaired, reason shown): invalid finding, unsupported category, zero length, outside the media, invalid duration. In the QA run two of three speech findings were zero-length words and therefore unavailable.

## 4. Overrides

Master switch, default action and per-finding choice take effect on the same render; turning actions off restores sound immediately; changing mute to skip mid-interval unmutes and skips on the next update; switching media starts fresh. Choices are keyed by occurrence (category, range, term), not by finding id, because ids shift when the term list changes. In memory only.

## 5. Tests

1,078 passing, 0 skipped (942 before, +136): interval planning (clamp, every unavailable reason, invalid durations, margins, override key), choice resolution and span merging, 53 coordinator scenarios on a fake player (before, inside and after the interval; entering; seeking into, out of and across; pause and resume; replay and repeated replay; overlapping, adjacent and simultaneous findings; ignored findings; automatic actions off mid-interval; user volume and mute changes during a span; media switch and late events after dispose; end of media; zero-length, non-finite and out-of-range input; determinism; no backward or repeated seek over a sweep of 300 updates; a player that always lands early), the video adapter, the boundary timer (from a timer alone, with no event), the panel on a jsdom video (every state and override, failure isolation, URL lifecycle, no storage use, hostile terms) and the dropzone flow. No test was removed or weakened.

## 6. Real-media verification (the actual app, a 36 s H.264/AAC video, real pipeline, headless-free browser pane)

The video really plays (readyState 4, 36 s; playhead advanced 2.0 to 7.0 in 5 s). Findings came from the real stack (speech and subtitles through whisper.cpp and FFmpeg). Verified by sampling the player every 20 ms:

| Check | Result |
| --- | --- |
| Mute on the subtitle-cue finding 3.00 to 5.40 s | muted from 3.024 s to 5.396 s, restored by 5.426 s; 0 muted samples outside; volume stayed 0.6 |
| First attempt, relying on `timeupdate` and animation frames | muted from 3.331 s (330 ms late): animation frames were throttled to about 2 per second in this browser; fixed with boundary timers |
| Skip on the same finding | jumped from 3.028 s to exactly 5.400 s; never played inside; announcement named the term and finding |
| User seeks into the skip interval while playing | respected: playback continued 4.15 s to 5.66 s, no skip, no loop |
| Master switch off | no skip, no mute, sound untouched; on again resumes |
| Ignore, then Undo ignore | no skip while ignored; undo returns to the default |
| Seek across the interval; play to the end; replay; replay again | no loop; skipped again on both replays |
| Choose another video | choices reset (mute became none), old object URL revoked, nothing left muted |
| Console | 0 errors across the whole flow on a fresh page (an earlier console entry was a stale hot-reload hook-order message from editing a hook while the page was open) |

Only the player's `muted` flag and playhead were measured; audio samples were not analysed, so "sound restored" means the flag, not a waveform. Not tested: files the browser cannot decode (covered by a unit test only), other browsers.

## 7. Frontend QA

No horizontal overflow at 320, 375, 768, 1024, 1280 and 1440 px. Screenshots: `docs/screenshots/checkpoint-8-*.jpg` (desktop with the playing video, a finding's action explanation at 1440, mobile 320). A naming collision with the existing filters switch drew a stray pill; renamed and re-checked. Separate screenshots at 375, 768, 1024 and 1280 were not taken (overflow only).

## 8. Performance (`npm run check:playback`)

One hour of 60 fps playback (every frame an event): 25 to 60 ns per event at 10 to 10 000 findings; setup 0.02 ms (10), 1.2 ms (1 000), 13 ms (10 000 findings), paid only when findings or choices change.

## 9. Security and privacy

No endpoint added or changed; playback controls cannot reach the file system; nothing is sent or stored by playback; client findings are never trusted over the server's (they are the CP7 findings unchanged); terms are rendered as text. **Still NOT solved: authentication (media ids are bearer tokens), rate limiting, disk quota, sandboxing.**

## 10. Known limitations

Not sample accurate; muting is the player's flag (no beep, no editing); word-timed margins can cut neighbouring words and subtitle-cue findings affect the whole line; word-timed speech findings are often zero-length and so unavailable; polling can miss a very short interval if the player stalls; skip accuracy depends on the player's seeks (retried); the file must stay in the page and the browser must be able to decode it; only flagged terms are supported.

## 11. Explicitly NOT implemented

Actions for any other category, any new detection, beep or audio replacement, blur, subtitle censoring, rendered or edited output, warnings and the pre-warning behaviour, saved preferences or presets, a media-serving endpoint. No Checkpoint 9 work was started.

## 12. Git

One commit `feat: add playback safety actions`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`, `git status -sb`.
