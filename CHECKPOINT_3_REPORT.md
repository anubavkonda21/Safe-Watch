# CHECKPOINT 3 REPORT

Scope: deterministic media extraction (audio, subtitles, frames) behind existing ports. **No AI model of any kind was implemented.**

## 1. Starting Git State

Verified before any change: branch `main`; working tree clean; `origin` = `https://github.com/anubavkonda21/Safe-Watch.git`; local `HEAD`, `origin/main` and `git ls-remote origin refs/heads/main` all `33f2feda40a7112e296b0a456846d41b26a98fd2` (`feat: add server media processing foundation`). FFmpeg 9.0.2 was already installed (Checkpoint 2).

## 2. Architecture

```
 MediaService (media READY) ── schedule ──► ProcessingQueue (extraction, default 1 job, bounded wait queue)
                                                   ▼
                              MediaExtractionService   (application: policy, caps, dedupe, limits, cleanup)
                                   │  uses ports                         shared pure domain (src/domain/extraction)
                                   ▼                                     MediaExtraction · AudioAsset · SubtitleCue
                              MediaExtractor (port)  ◄── implements ──   Frame · lifecycle · cue normalisation
                                                         FfmpegMediaExtractor   frame planner · manifest validator
                                                              │ spawn(argv[], shell:false)
                                                         ffprobe / ffmpeg
                              MediaStorage (port): withExtractionDir · readArtifact · deleteArtifact · deleteExtraction
                                   └─ <uuid>.media   <uuid>.extraction/{audio,frames}/
```

- Extends, does not duplicate: `MediaRecord` gained an `extraction` field next to `analysis`; `MediaStorage` gained extraction-directory operations (and `delete` now removes derived assets too); the API gained one route; the existing queue class, process runner, ffprobe argument builders, `normalizeMetadata` and sanitising helpers are reused.
- The FFmpeg adapter implements four single operations (`inspect`, `extractAudio`, `extractSubtitleCues`, `sampleFrame`). Policy (which tracks, dedupe, caps, limits, phases, cleanup) lives in the application layer and is tested with a fake extractor, without FFmpeg.
- Future AI code will only see `AudioAsset`, `SubtitleCue`, `Frame`: no FFmpeg commands, FFprobe JSON, subprocess objects, paths or stderr cross the port boundary.

## 3. Extraction Lifecycle

Three separate states, never merged:

| | Values |
| --- | --- |
| MEDIA | `uploaded → processing → ready \| failed` |
| EXTRACTION | `not_started → queued → processing → completed \| failed` (illegal transitions throw; failure discards partial assets) |
| ANALYSIS | `not_started` (no analysis exists) |

Phases while processing: `preparing → extracting-audio → extracting-subtitles → sampling-frames → finalizing`. Progress is **phase-based only**; no percentage is ever fabricated (a test asserts no `%` appears). A successful run ends with `MEDIA=ready, EXTRACTION=completed, ANALYSIS=not_started` (asserted end to end). A failed extraction leaves media `ready`. Extraction is triggered automatically after media is ready and never blocks the upload request (the upload still returns 202 immediately).

## 4. Audio Extraction

- **Format (decision, documented in `SAFEWATCH_MEDIA_ARCHITECTURE.md` §19):** WAV, PCM s16le, 16 kHz, mono: the input speech-to-text engines expect, universally readable, no codec dependency, byte-deterministic (`-fflags +bitexact`). Alternatives considered: FLAC, Opus/AAC, codec copy. Cost: about 115 MB per hour per track (measured: 110 MB per track for a 1-hour video, which was **larger than the 187 MB source** with two tracks).
- **Metadata captured:** stream index, language, title, dispositions (default, forced, original, hearing-impaired, commentary), source codec/sample rate/channels/bit rate, output format, duration (computed exactly from output size), size, logical artifact name.
- **Selection policy:** all audio streams, in container order, up to 8; extra streams are reported as warnings (never silently dropped). Zero tracks → `audio: []` (tested on a real video without audio). Multiple tracks tested with a real MKV (English and Spanish). Bit-identical tracks (SHA-256) are recorded with `duplicateOf` and stored once (tested with a real fixture). Multi-channel audio is down-mixed to mono.
- **Audio-only media:** not supported; ingestion already rejects files without a video stream (`MEDIA_METADATA_FAILED`).
- **Security/limits:** argv arrays, `shell:false`, server-generated output name inside the job directory (path-escape guard), timeout, `-fs` output cap, **one total audio budget per media** (default 512 MB) checked from the duration before decoding and enforced on the actual output, partial output deleted on every failure.

## 5. Subtitle Extraction

- **Detection:** index, language (ISO, `und` → null), title, codec, dispositions, and kind: `text` (subrip, ass/ssa, webvtt, mov_text, …), `image` (hdmv_pgs, dvd, dvb, xsub), `unknown` (never assumed text).
- **Text extraction:** FFmpeg → SubRip on stdout (capped), then a pure parser keeps millisecond timing; cues are normalised. Tested with real SRT, ASS and mov_text tracks.
- **Normalisation (documented):** formatting tags and ASS overrides removed, `\N` → line break, basic entities decoded, control/zero-width/bidi characters removed, whitespace collapsed, blank lines/empty cues/invalid timing/exact duplicates dropped, cues ordered, text capped at 4,000 characters; words, casing and timing preserved; `<laughs>`-style text kept. Output is plain text.
- **Image subtitles:** `kind: image`, `textExtraction: unsupported`, no cues, shown in the UI as "not readable as text". **No OCR.** Verified with a real PGS stream (hand-assembled minimal `.sup` muxed into MKV; see limitation about real-world PGS).
- One unreadable text track is a warning (`textExtraction: failed`), not a failed extraction.
- Subtitle text is never logged (test asserts it) and is rendered by React as text (test renders `<img onerror>`/`<script>` titles and asserts nothing is injected).

## 6. Frame Sampling

- **Plan (pure function, unit-tested):** `count = min(maxFrames, ceil(duration/interval))`; the video is divided into `count` equal intervals and sampled at each interval's **middle**; millisecond-rounded. If the cap applies, the interval grows so samples still span the whole video. Defaults: 10 s interval, 300 frames max. The effective interval is recorded.
- **Bug found by the tests:** the first version divided by the requested interval, so a 1-second video planned a frame at t = 5 s (past the end) and partial last intervals overshot. Fixed by dividing the video into equal intervals; covered by tests.
- **Method (decision, §21):** one fast input-seek per frame, run sequentially. Alternatives (sequential `fps` filter, keyframe-only, hybrid) were rejected for decode cost or irregular spacing. Documented trade-off: cost grows with frame count and keyframe distance; bounded by the job timeout.
- **Format and size:** JPEG (`-q:v 4`, `yuvj420p`), fitted inside 768×768 preserving aspect ratio, never upscaled; actual dimensions are read from the JPEG header. A 3840×2160 source produced 768×432 frames. Rejected: WebP (compat/CPU), PNG (size).
- Each `Frame` has id, index, timestamp, width, height, format, size and a logical artifact name. **No image bytes are in the manifest.** Scene detection is not implemented; the planner is isolated so one can feed it later.
- Unknown duration → first moment only, with a `duration-unknown` warning. A moment with no decodable frame → warning; all moments failing → fatal.

## 7. Normalized Manifest

`MediaExtraction { mediaId, status, phase, audio[], subtitles[], frames{config, effectiveIntervalSeconds, totalSizeBytes, frames[]}, createdAt, startedAt, completedAt, errors[], metrics{durationMs, stageMs{audio,subtitles,frames}, toolProcesses, outputBytes} }`. Serialisable, tool-neutral (the metric is `toolProcesses`, not `ffmpegProcesses`; a test caught the earlier name). `errors[]` holds structured issues `{code, stage, fatal, streamIndex}` with fixed codes (`timeout`, `limit-exceeded`, `invalid-media`, `extraction-failed`, `invalid-output`, `cancelled`, `server-busy`, `duration-unknown`, `track-unavailable`, `frame-unavailable`). Before completion the manifest is checked by `validateExtraction` (ids unique, frame indexes and strictly increasing timestamps inside the media, sizes within limits, totals match, cue timing/order/counts, image tracks without cues, audio duplicates resolvable); a violation fails the extraction as `invalid-output` rather than publishing it. No raw FFmpeg output, FFprobe JSON, subprocess objects or paths are included (asserted).

## 8. Storage

`<uuid>.media` plus `<uuid>.extraction/{audio,frames}/` (dirs 0700, files 0600), accessed only through `MediaStorage`; application code works with logical artifact names validated against `^(audio|frames)/[a-z0-9-]{1,40}\.(wav|jpg)$`. **Retention** (one clock, 60 minutes from upload): original, extracted audio, subtitle data (held in the manifest in memory) and frames. **Cleanup paths, each tested:** success (all expected outputs exist, checked on disk), failure and timeout (partial outputs deleted, media stays), media `DELETE` (original and all extraction assets disappear; a running extraction is aborted first), expiry (record, original and extraction directory removed), server restart (startup purge removes extraction directories), orphaned extraction directory (age-based sweep), and `delete` failing (logged, retried by sweep).

## 9. Resource Limits

| Limit | Default | On breach |
| --- | --- | --- |
| Job timeout | 10 min | processes killed, `failed: timeout`, partial output deleted |
| Concurrent extraction jobs | 1 (queue of 20) | beyond queue: `failed: server-busy`, media stays ready |
| Frames | 300 | planner never exceeds (interval grows) |
| Frame bytes | 64 MB total | `failed: limit-exceeded`, cleanup |
| Audio bytes | 512 MB total, 8 tracks | pre-checked + enforced on output; extra tracks warned |
| Cues / subtitle bytes | 50,000 / 8 MB per track | track `failed` + warning |
| Single FFmpeg step | 60 s | aborted as `timeout` |
All except the fixed 60-second single-step bound are environment-configurable and validated at startup (invalid or unbounded values are rejected). The pathological case from the brief ("1 video → 500,000 frames") is impossible by construction: requesting one frame per second on a 1-hour video still produced exactly 300 frames (measured).

## 10. Security

Every Checkpoint 2 control is preserved and covered by the new code paths: argv arrays only, `shell:false`, minimal environment, closed stdin, `-protocol_whitelist file`, demuxer forced from the verified container, timeouts, stdout caps, SIGKILL on abort. Added: server-generated output names under the job's directory with `safeJoin` (traversal tests), artifact-name allow-pattern, stream indexes and timestamps are numbers formatted by us (an injection attempt via `streamIndex` is tested), hostile stream metadata is sanitised (a title with `<script>` and a bidi override and a path-like language were tested end to end: bidi removed, language null, text inert), subtitle text is never logged, the API never returns paths or tool output (asserted), output caps and partial-output removal for audio, subtitles and frames. **FFmpeg isolation is NOT COMPLETED and is not solved by this checkpoint.** It remains a production security gate (see §21).

## 11. API

- `GET /api/media/:id/extraction` → `{ extraction }` (manifest above). `404 NOT_FOUND` for unknown or malformed ids; other methods → 404.
- `GET /api/media/:id` now returns `{ asset, extraction: {status, phase}, analysis }`.
- Failed extraction is returned as a normal manifest with `status: "failed"` and structured `errors` (no stack traces, tested). No endpoint serves artifact bytes yet.

## 12. Frontend

Upload and extraction are shown as separate steps. After "Media ready" the card shows a phase-based "Preparing analysis assets" panel (Audio / Subtitles / Frames steps with done/active/pending marks, an indeterminate bar, no numbers), badges `MEDIA: READY · EXTRACTION: … · ANALYSIS: NOT STARTED`, then on success the message **"Media prepared. Ready for SafeWatch analysis."** with "SafeWatch has not analyzed this video yet", a summary (audio tracks, subtitle tracks, frames sampled, prepared in) and an expandable "Extraction details" (per-track language/title/codec/format/duration/cue count, image-subtitle note, frame settings, skipped items). A failed extraction is its own red alert while media stays READY ("Your media is still stored and ready"). No "safe" / "analysis complete" wording exists (a test asserts it). The hook applies the final manifest even if the port never calls `onUpdate`, ignores updates from a replaced upload, and reports a lost server as an extraction problem. Landing page and design tokens untouched; only existing colors/spacing/radii used; browser-only mode (no server) shows no extraction UI.

## 13. Tests

`npm test` (Vitest, two projects): **381 passed, 0 failed, 0 skipped** (web 217 in 16 files; server 164 in 12 files). Checkpoint 2 had 246; +135 new tests.
- Domain: lifecycle transitions (legal/illegal), manifest validator (frames, cues, audio), cue normalisation and SRT parsing (incl. hostile text), codec classification, frame planner (determinism, cap, pathological request, short/partial intervals), `fitWithin`.
- Audio / subtitles / frames against **real FFmpeg**: stream inspection (languages, titles, dispositions), WAV format verified with ffprobe, duration/size, no-audio, duplicate audio, SRT/ASS cues and timings, mov_text, real PGS image track, JPEG sizing, 1080p → fitted box, never upscaled, no-frame → null, size limits, abort → no partial files, bad stream index.
- Security: path traversal in output paths and artifact names, injection attempt through a stream index, hostile metadata end to end, subtitle text not logged, no paths/tool output in the API, limits, timeout.
- API/integration: extraction endpoint (404s, not_started, failed, structured errors), phases observed live, concurrency bound (peak 1), queue-full `server-busy`, cleanup (delete, abort during extraction, expiry, orphan sweep, restart purge, timeout), and a genuine **end to end** run: upload → media ready → extraction queued → audio → subtitles → frames → manifest → delete → disk empty.
- Frontend: reducer extraction events, uploader polling/timeout/unreachable/abort, extraction UI (progress phases without percentages, summary, details, image subtitles, inert hostile titles, zero tracks, four failure types, lost server, replaced upload, browser-only mode).
Lint and typecheck: clean. The full suite was run several times and the server project repeatedly (including the determinism test) with no failures after the fixes described above. Tests that need FFmpeg skip themselves if it is absent (none skipped here).

## 14. Determinism Test

Mandatory test `server/test/determinism.test.ts`: a generated 25-second MKV (H.264, two audio tracks eng/deu, one SRT track) extracted **twice** through two separate uploads with identical configuration (5 s interval, 320×320 box). **Result: identical.** Both runs produced 6 frames (the container reports about 25.1 s, so `ceil(25.1/5)=6`) with identical timestamps; identical cue timings and text; identical audio metadata; identical normalised manifest (after replacing media id and wall-clock fields; metrics reduced to process count and output bytes); and **byte-identical files**: the SHA-256 of all 8 artifacts (2 WAV + 6 JPEG) matched between runs. Determinism holds on this machine with this FFmpeg build (9.0.2); across FFmpeg versions, platforms or hardware-accelerated decoders it is **not tested**.

## 15. Resource Test

Generated outside the repository (not committed), measured with `npm run check:extraction`, in-process server, real FFmpeg and storage, loopback:

**Long video:** 1 hour, 1280×720 @ 5 fps H.264, 2 AAC tracks (eng, spa), 2 SRT tracks × 1,200 cues, MKV, 186.5 MB.
| Measure | Result |
| --- | --- |
| Extraction duration | 18.4 s total (audio 3.1 s, subtitles 0.17 s, frames 15.1 s); 18.6 s end to end incl. upload and probe |
| Output | 226.6 MB on disk: audio 2 × 110 MB = 219.7 MB, frames 300 = 6.9 MB, cues 2,400 |
| Frame count | **300** at 768×432 (effective step 12 s) |
| Audio output size | 219.7 MB (**121.5% of the source** — WAV is large; see limitations) |
| Peak memory | Node heap 9.5 → 18.3 MB; Node RSS peak 180 MB; FFmpeg child RSS peak 24 MB |
| FFmpeg processes | 305 launched in total; **peak concurrent: 1** |
| Cleanup | 10.4 ms, 0 files left |
| Pathological request (1 frame/s on the same video) | still exactly 300 frames, same time and size |

**4K video:** 3840×2160, 40 s, 30.6 MB: frames downscaled to 768×432 (4 frames, 0.1 MB), extraction 0.64 s, output 4.2% of source, **FFmpeg child RSS peak 307 MB** (a decoding cost nothing limits today), cleanup 1.4 ms.

CPU behaviour: not measured (only memory and process counts were sampled). Conclusion supported by the data: frame sampling does not explode in size or count; audio output is the dominant and unavoidable cost.

## 16. Performance

| Measure | Result |
| --- | --- |
| Server startup (dev, tsx, to first healthy `/api/health`) | 274 ms; production bundle was 87 ms in Checkpoint 2 |
| Extraction startup (media ready → extraction processing) | 46–47 ms (includes the media probe, measured from upload time) |
| Small real files | 3 s MKV, 2 audio + 2 subtitle tracks: extraction 141 ms (audio 48, subtitles 45, frames 25), 6 processes. 1 s MP4: 68 ms, 3 processes |
| 1-hour video | audio 3.1 s, subtitles 0.17 s, frames 15.1 s, total 18.4 s |
| Total output / peak memory / processes | see §15 |
| Frontend bundle | JS **297.67 kB (94.04 kB gzip)**, CSS 19.48 kB (4.75 kB gzip). Checkpoint 2: 288.31 kB (91.66 gzip) / 18.08 kB (4.52 gzip). **+9.36 kB JS (+2.38 gzip), +1.40 kB CSS** |
| Server bundle | 75.28 kB (23.49 kB gzip); Checkpoint 2: 39.87 kB |

## 17. Visual Verification

Real browser, real API, real extractions (frames, audio and subtitles extracted from actual uploaded video files), widths **320, 375, 768, 1024, 1280, 1440**: no horizontal overflow at any width; upload card 288 px (320), 343 px (375), 680 px (768 and up); mobile menu control hidden from 768. Checked at each width: long filename (90 characters at 320, wrapped), extraction summary, expanded details (multi-track MKV at 320/768/1024/1280/1440; an image-subtitle MKV at 375 confirmed the "not readable as text" note), status badges, buttons. Extraction **in progress** (phase indicators), **completed**, and **failed** were driven live at the default pane width; the failure used a second API instance with a deliberately tiny frame budget (a real `limit-exceeded`), and the server log confirmed the partial extraction directory was removed. Not captured at every width: the in-progress and failed states (checked at one width); landing page navigation/hero were not re-inspected beyond overflow checks because they did not change.

## 18. Screenshots

Committed in `docs/screenshots/`:
1. `checkpoint-3-1-extraction-in-progress.jpg` — Audio ✓, Subtitles ✓, Frames active, "Sampling frames…", extraction badge "in progress".
2. `checkpoint-3-2-extraction-completed.jpg` — "Media prepared. Ready for SafeWatch analysis." with summary (2 audio tracks, 2 subtitle tracks, 300 sampled, prepared in 16.3 s).
3. `checkpoint-3-3-extraction-failed.jpg` — `MEDIA: READY`, `EXTRACTION: FAILED`, "This video is too large to prepare".
4. `checkpoint-3-4-mobile-320-completed.jpg` — completed state at 320 px with expanded details.

## 19. Dependencies Added

**None.** No new runtime or dev dependency. Subtitle parsing, SHA-256 (`node:crypto`), JPEG size reading, language names (`Intl.DisplayNames`) and the process runner all use the standard library or existing code. One npm script was added: `check:extraction` (beside the existing `check:large`).

## 20. Known Limitations

- **WAV is large:** a 1-hour two-track video produced 220 MB of audio, more than the 187 MB source. The 512 MB total budget (about 4.4 hours of one track) is the only guard. Compression (FLAC/Opus) is a deliberate future trade-off.
- **Frame cost:** per-frame seeking took 15 s for 300 frames on a 1-hour 720p H.264 file; very long GOPs, 10-bit/HEVC 4K or slow storage will be slower (bounded by the 10-minute timeout, then fails). Requested timestamps are recorded, not decoded pts (within one frame).
- **Colour handling:** HDR/10-bit sources are not tone-mapped; not tested.
- **Subtitles:** ASS styling/position is lost; SubRip conversion by FFmpeg decides line/cue splitting; no OCR; teletext/closed-caption streams are `unknown`; limits (50,000 cues) not exercised beyond 2,400 cues.
- **Image subtitles:** verified only with a hand-assembled minimal PGS stream; real PGS, DVD and DVB files were not tested (DVD/DVB are covered by codec classification only).
- **Audio:** channel down-mix to mono discards channel separation; duplicate detection catches only bit-identical audio; language names depend on the platform's `Intl` data.
- **Duration unknown** → only the first frame is sampled.
- **State is in memory:** manifests (including cues) vanish on restart; artifacts are not served over HTTP, so the UI cannot preview frames or play extracted audio.
- **Queue behaviour:** a full extraction queue fails the extraction (`server-busy`) rather than waiting; there is no cancel or retry endpoint (delete the media to cancel).
- **Progress** is phase-based; the frames phase has no sub-progress although the frame count is known.
- **Not tested:** Linux, non-faststart MP4 with `moov` at the end, files over 2 GB through extraction, hardware decoders, CPU usage, concurrent extractions above 1, FFmpeg versions other than 9.0.2.
- The two videos used for the resource test (1-hour 720p MKV, 40-second 4K MP4) were generated with FFmpeg's `lavfi` sources (`testsrc2` + `sine`, plus generated SRT files) and live outside the repository; they are not committed and the exact generation commands are not stored in the repo. `npm run check:extraction` accepts any file, so the test can be repeated with other media. Synthetic test patterns compress far better than real footage, so the measured frame sizes (6.9 MB for 300 frames) understate real-world frame storage; the 64 MB cap is what bounds it.

## 21. Security Risks Remaining

1. **FFmpeg isolation: NOT COMPLETED** (unchanged production gate). FFmpeg parses untrusted media in the API process with no OS sandbox, separate user, filesystem/network restriction, or memory/CPU cgroup. Measured: a 4K decode reached about 307 MB RSS in a child unconstrained by anything.
2. **No authentication or authorisation;** media ids are unguessable bearer tokens; `DELETE` is unauthenticated.
3. **No per-client rate limiting;** one client can occupy all upload and extraction slots.
4. **Disk exhaustion:** per media item up to the original (2 GB) + 512 MB audio + 64 MB frames; with 4 concurrent uploads and a 60-minute retention there is no volume quota or free-space check.
5. **Untrusted text in memory:** subtitle cues and track titles are sanitised and rendered as text, but any future consumer (AI prompts, logs, HTML) must still treat them as untrusted; prompt-injection through subtitles is a Checkpoint 4+ concern.
6. **Data retention policy** for derived assets (audio, frames) is the same 60 minutes; the final privacy policy is a product decision.
7. **Parser exposure:** FFmpeg demuxers/decoders and the MJPEG encoder run on hostile input; forced demuxers and protocol whitelist reduce but do not remove this.

## 22. Future AI Boundary

```
 EXTRACTION (this checkpoint)  ─►  NORMALISED ASSETS  ─►  FUTURE AI ANALYSIS (NOT IMPLEMENTED)
                                    AudioAsset   id, ordinal, streamIndex, language, title, dispositions,
                                                 source codec/rate/channels, format WAV 16 kHz mono PCM,
                                                 durationSeconds, sizeBytes, artifact, duplicateOf
                                    SubtitleTrack/SubtitleCue  language, title, codec, kind, textExtraction,
                                                 cues[{index,startSeconds,endSeconds,text}]  (plain, untrusted)
                                    Frame        id, index, timestampSeconds, width, height, JPEG, sizeBytes, artifact
```
Future systems will receive: one 16 kHz mono WAV per distinct audio track (with language and track metadata, ready for speech-to-text and for aligning transcript time to video time), timestamped plain-text cues per text subtitle track (images flagged unsupported so analysis knows the gap), and a bounded, evenly spaced set of JPEG frames with their timestamps (ready for vision models, at most 300 per video). Artifact bytes are read server-side through `MediaStorage.readArtifact(mediaId, artifact)`; the AI layer never needs FFmpeg, FFprobe output, subprocess objects or file paths. **AI models are not implemented in Checkpoint 3.**

## 23. Git

- Commit message: `feat: add media extraction pipeline`
- Commit hash, push result and local/remote synchronization: reported in the final message and verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main` and `git status -sb` (a commit cannot contain its own hash).
- Remote: `origin` → `https://github.com/anubavkonda21/Safe-Watch.git`; normal push to `main`; no force.
- Working tree after the commit: clean.
