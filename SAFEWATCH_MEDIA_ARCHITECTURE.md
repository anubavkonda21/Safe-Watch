# SafeWatch Media Architecture

Status: decided in Checkpoint 1; the server foundation was implemented in Checkpoint 2 (see §14–§17). Audio/subtitle/frame extraction is still planned.

## 1. Problem

SafeWatch must eventually understand what is inside a video, so it needs to:

| Stream | Needs |
| --- | --- |
| Video | duration, resolution, frame rate, codec; controlled frame sampling with timestamps for vision models |
| Audio | detect audio streams; extract audio for speech-to-text |
| Subtitles | detect embedded tracks; extract; parse; keep timestamps |
| Frames/segments | extract at controlled rates, keyed by timestamp, as future model input |

Constraints that shape the choice: videos are large (hundreds of MB to several GB); containers and codecs are diverse (MKV, AVI, HEVC, AC-3 are common and poorly supported by browsers); AI provider keys must never reach the browser; the content is private and often sensitive; the product is early-stage.

## 2. Current architecture

(From Checkpoint 0A.) Vite + React SPA only. No backend. `MetadataReader` port with a browser adapter that reads duration and dimensions through a detached `<video>` element. FFmpeg and FFprobe are **not installed** on the development machine (macOS arm64, 16 GB RAM, Node 24); Docker is not installed. Nothing leaves the user's device.

## 3. Options considered

- **A. Browser-only** (ffmpeg.wasm / WebCodecs / `<video>`).
- **B. Vite frontend + Node/TypeScript API** that shells out to a system FFmpeg/FFprobe (same repo, shared domain types).
- **C. Vite frontend + dedicated media-processing service** (separate deployable, queue/worker, probably containerised).
- **D. Managed/cloud media processing** (e.g. a transcoding/analysis API or cloud functions plus object storage).
- **E. Native/desktop wrapper** (Electron/Tauri with bundled FFmpeg).

## 4. Comparison

| Criterion | A Browser | B Node API | C Dedicated service | D Managed cloud | E Desktop |
| --- | --- | --- | --- | --- | --- |
| Dev complexity | Low initially, high later (wasm workarounds) | Low–moderate | High | Moderate (integration) | High |
| Performance | Single-threaded wasm is slow; no hardware decode | Native FFmpeg, fast | Native, independently scalable | Fast, vendor-limited | Native |
| Browser compatibility | Poor for MKV/AVI/HEVC; wasm needs COOP/COEP headers for threads | Irrelevant (server decodes) | Irrelevant | Irrelevant | Irrelevant |
| FFmpeg requirements | ~30 MB wasm bundle, limited codecs/filters | System binary, full feature set | System binary in image | Vendor-provided | Bundled binary |
| Security | Files stay local (good); but AI keys cannot live here | Untrusted-file parsing on our server: needs hardening | Best isolation (sandboxed worker) | Delegated; vendor trust | Local only |
| Scalability | Scales with users' devices; unreliable on weak ones | Vertical first; limited by one process | Horizontal | Horizontal | n/a |
| Deployment complexity | Static hosting | One service + FFmpeg on host | Multiple services, orchestration | Low ops, high integration | Installers/updates per OS |
| Cost | Zero infrastructure | Low | Medium–high | Usage-based, can grow fast | Distribution cost |
| Local development | Trivial | Simple once FFmpeg installed | Needs containers/queue | Needs cloud credentials | Heavy |
| Production feasibility | Weak for target feature set | Good | Good (later) | Good, but privacy/cost trade-offs | Narrow reach |
| Future AI integration | Keys exposed; heavy models in-browser impractical | Natural: server holds keys, calls providers | Natural | Natural but coupled | Possible |
| Background processing | None (tab must stay open) | In-process queue now, worker later | Native fit | Native fit | Local |
| Large files | Memory-bound (wasm ~2 GB limit, copies in MEMFS) | Stream to disk, process from disk | Same, plus dedicated storage | Direct-to-bucket uploads | Disk-based |
| Concurrent users | N/A (client compute) | Limited by one box | Good | Good | N/A |

## 5. Decision

**Option B, adopted in phases.** SafeWatch will be a Vite SPA plus a Node/TypeScript API in the same repository. The API runs FFprobe/FFmpeg as external processes (argument arrays, never shell strings), stores uploads on local disk behind a storage port, and runs jobs through an in-process queue behind a job port. Shared pure domain code (`src/domain`) is reused by both sides.

Phasing:

1. **Checkpoint 1 (this one):** define the media domain, ingestion service, `MediaProcessor` port and state machine; ship the browser adapter only. No server, no FFmpeg.
2. **Checkpoint 2:** introduce the server, `FfprobeMediaProcessor`, streamed upload, and audio/subtitle extraction, because speech-to-text and subtitle intelligence are the first features that cannot be done in a browser.

## 6. Why

- The feature set (audio extraction, embedded subtitles, frame sampling, broad codecs) requires real FFmpeg. Browser-only (A) cannot deliver it reliably, and AI provider keys must sit server-side regardless.
- B is the smallest architecture that satisfies that: one extra process, one language, shared types, easy local development. C and D add operational and cost surface that nothing demands today.
- B does not close the door on C: because processing sits behind `MediaProcessor` and (later) `MediaStorage`/`JobQueue` ports, extracting a worker service is a change of adapter, not a rewrite.
- D would send users' private media to a third party by default and makes costs scale with every upload. It can be reconsidered for specific heavy stages (e.g. a hosted vision API is in any case an AI concern, not an ingestion one).
- The server is not built in this checkpoint because FFmpeg is not installed, it could not be verified here, and the contract can be established and tested without it. Building untested server code now would be speculative.

## 7. Data flow

Implemented now (client only):

```
 File (user)
   │  drop / choose
   ▼
 [validating]  domain: extension + MIME allowlist, size limit, filename sanitised
   │           application: read first 64 bytes (file.slice), sniff container, must match extension
   ├── fail ──► [failed]  typed MediaIngestionError (code)
   ▼
 [accepted]    MediaAsset created (id, sanitised name, detected type, size, metadata: pending)
   ▼
 [processing]  MediaProcessor.extractMetadata(file)   ← port
   │             adapter: BrowserMediaProcessor (detached <video>, object URL, revoked after use)
   │             metadata unreadable ⇒ availability "unavailable" (file is still VALID)
   ├── throws ─► [failed]
   ▼
 [ready]       MediaAsset { status: ready, metadata } — stable reference for future analysis
```

Target (Checkpoint 2+):

```
 Browser ──(chunked/streamed upload)──► API ──► MediaStorage (disk)
                                          │
                                          ▼
                                   JobQueue (in-process)
                                          ▼
                    FfprobeMediaProcessor ──► MediaAsset (full metadata)
                                          ├─► audio extraction ─► (Checkpoint 2 STT)
                                          ├─► subtitle extraction ─► (Checkpoint 2)
                                          └─► frame sampling ─► (Checkpoint 4 vision)
```

## 8. Security

Principles for uploaded media (client checks are a convenience; the server must re-validate everything):

- Treat every file as hostile. Extension and MIME are advisory; the container signature (magic bytes) must agree. Even that proves only the header, not that the file is benign (polyglots exist); FFprobe/FFmpeg are themselves parsers of untrusted input.
- Server stage: random server-generated IDs for storage paths (user filenames are display-only); upload size limits enforced while streaming; FFmpeg invoked via `spawn` with an argument array, a fixed allowlist of options, `-nostdin`, no user-controlled options or protocols (`-protocol_whitelist file`), CPU/time/memory limits, a restricted working directory, and an unprivileged user. Never interpolate filenames into shell strings.
- Subtitle and transcript text is untrusted: escape on render and treat as data in any prompt (prompt-injection) in future AI stages.
- Do not log filenames verbatim or file contents; errors shown to users are typed and generic about internals.

## 9. Storage

- **Now:** nothing is stored. The `File` stays in browser-managed storage; the object URL used for metadata is revoked immediately after.
- **Checkpoint 2:** local disk under a configured directory, behind a `MediaStorage` port. Originals are temporary: deleted after analysis or on a TTL; derived artefacts (audio, frames, subtitles) are deleted with the asset. Default is *not* to retain media permanently; any permanent storage will be an explicit product decision.
- **Later:** an object-store adapter (S3-compatible) behind the same port, with direct/resumable uploads.

## 10. Processing

- **Now:** in the browser, limited to duration and dimensions via the platform's `<video>` decoder. Codec, frame rate, audio/subtitle presence are **unknown** (`null`) in browser metadata; they are not guessed.
- **Later:** on the server via FFprobe (metadata, streams) and FFmpeg (extraction), always reading from disk, never loading whole files into memory. Large files: browser uploads by streaming/chunking (`File.slice` / `fetch` with a stream body or a resumable protocol), server writes to disk incrementally, processing reads from disk. Memory stays proportional to chunk size, not file size.

## 11. Future AI integration

AI stages consume a `MediaAsset` plus derived artefacts (audio file, subtitle cues with timestamps, sampled frames with timestamps) produced by the pipeline. They run server-side behind their own ports (speech, text, vision), so provider keys never reach the client and providers can be swapped. Cost is dominated by frame count and audio duration, so extraction stages expose sampling controls. Detection, risk and policy stages (Checkpoints 3–9) consume stage outputs, not raw media.

## 12. Deployment

- **Now:** static hosting (any CDN/static host) is sufficient for the SPA.
- **Checkpoint 2+:** one Node service on a VM or container platform with FFmpeg installed and a disk volume, serving the API and (optionally) the built SPA. Containerisation is an optional packaging choice then, not an architectural requirement.
- **Scale-out path:** split the job runner into a separate worker process using the same ports (becomes Option C), add an external queue and object storage when concurrency or file size demands it. Not before.

## 13. Alternatives rejected

- **A. Browser-only:** cannot extract embedded subtitles/audio reliably, poor codec coverage, memory-bound for large files, no safe place for AI keys. Retained only for local pre-validation and light metadata.
- **C. Dedicated service now:** operational cost with no current load to justify it; reachable later through ports.
- **D. Managed cloud now:** privacy and recurring cost for an unproven product; adds vendor coupling before requirements are known.
- **E. Desktop wrapper:** limits reach and multiplies distribution work; the product is web-first.

---

## 14. Checkpoint 2 implementation (what was actually built)

**Repository layout (decision).** One repository, two entry points, one shared pure domain:

```
src/domain/            shared by browser and server (media model, validation, sniffing, API contract, analysis boundary)
src/{application,infrastructure,features,...}   browser
server/src/{api,application,domain,infrastructure}   Node API
```

The server imports `@/domain/*` directly; domain files have no Node or browser dependencies, so nothing is duplicated and no package split is needed yet. If a second consumer appears, `src/domain` can be extracted to a workspace package without changing imports' meaning.

**Layering.** `api` (HTTP only) → `application` (`MediaService`, ports) → `domain` ← `infrastructure` (adapters). Neither the HTTP layer nor the application layer contains FFmpeg commands, filesystem paths or media parsing.

**Upload protocol (decision).** The file is the raw request body (`POST /api/media`, filename in `X-SafeWatch-Filename`), not multipart. It removes a parsing dependency and a class of multipart bugs, streams naturally (`HTTP stream → signature check → .part file → rename`), and lets the browser's `XMLHttpRequest` report real upload progress. The server answers `202` once the bytes are stored; processing runs asynchronously through a bounded in-process queue and the client polls `GET /api/media/:id`.

**Statuses (decision).** Media: `uploaded → processing → ready | failed` (plus client-only `accepted`). Analysis: `not_started | queued | processing | completed | failed`, carried separately in every response. No analysis exists yet, so it is always `not_started`.

## 15. Media and storage lifecycle

| Event | What happens |
| --- | --- |
| Upload starts | Cheap checks (extension, MIME, declared size, concurrency) run before any byte is read. Bytes stream to `<uuid>.part` (mode 0600) in a 0700 directory; the first 64 bytes are sniffed *while streaming* and a mismatch aborts the upload. |
| Upload completes | `.part` is renamed to `<uuid>.media` (atomic: a crash cannot leave a half-written file that looks finished). Record `uploaded`. |
| Processing | Queue slot → `processing` → FFprobe metadata, then FFmpeg decode smoke test (first 2 s), under a timeout. |
| Success | `ready`; the original stays on disk (future stages need it) until deleted or expired. |
| Failure | Record `failed` with a typed code; **the file is deleted immediately**. |
| Timeout | The child process is killed (`SIGKILL`), record `failed: timeout`, file deleted. |
| Upload error / client disconnect / over limit / deadline | `.part` removed, nothing registered. |
| User replaces or leaves | Client calls `DELETE /api/media/:id` (best effort). |
| Retention | Records expire after `SAFEWATCH_RETENTION_MINUTES` (default 60); a periodic sweep deletes expired media. |
| Delete fails | Logged; retried by the next sweep, which also removes any owned file older than the retention window regardless of registry state. |
| Server crash / restart | Records are in memory and are lost; the storage directory is **purged at startup**, and again at graceful shutdown. |

Safety rails: ids are validated UUIDs before any path is built; the directory must be empty or carry a SafeWatch marker file; purge/sweep only touch names matching `<uuid>.(media|part)`.

## 16. FFmpeg Runtime Strategy

### Local development
Install FFmpeg with the platform package manager (macOS: `brew install ffmpeg`, which installed FFmpeg/FFprobe 9.0.2 on this machine). The server resolves `ffmpeg`/`ffprobe` from `PATH` or `SAFEWATCH_FFMPEG_PATH`/`SAFEWATCH_FFPROBE_PATH`, and refuses to start with instructions if they are missing. No Docker is needed.

### Production
Options evaluated:

| Option | Pros | Cons |
| --- | --- | --- |
| **System package** (apt/dnf on the host or VM) | Simplest; security patches via OS updates; no extra moving parts | Version varies by distro; host is shared with the API |
| **Docker image** (FFmpeg in the API image) | Reproducible, pinned version, easy sandboxing (non-root, read-only FS, CPU/memory limits, no network) | Adds a container platform and image maintenance |
| **Bundled static binary** (`ffmpeg-static`/vendored) | Zero system dependency | Supply-chain and licensing burden (GPL/LGPL, codecs), slow security updates, larger artefacts |
| **Managed media service** | No FFmpeg ops | Media leaves our infrastructure (privacy), per-minute cost, vendor coupling |

**Choice for the current stage: system package on the API host.** It needs no new platform and gets security updates with the OS. Pin the major version in deployment docs and keep the `SAFEWATCH_*_PATH` override. **Not yet solved** (honest gaps): per-process CPU/memory/time limits beyond the application-level timeout and output cap, running FFmpeg as a separate unprivileged user, filesystem/network sandboxing (seccomp, containers), and an FFmpeg security-patch policy. These are Checkpoint 10 work.

### Future scaling
Move to a **Docker image with a locked-down runtime** (non-root, read-only root FS, memory/CPU limits, no network) when either (a) untrusted-media risk needs stronger isolation than process-level limits, or (b) the job runner becomes a separate worker service. At that point swap `LocalDiskMediaStorage` for an object-store adapter and `ProcessingQueue` for an external queue; both are behind ports already. Managed services remain an option only for specific heavy stages, decided with a privacy review.

## 17. Hardening applied to every FFmpeg invocation

- Executed with `spawn(binary, argsArray, {shell:false})`; the media path is a single argv element after `-i`, never concatenated into a string.
- The input path is always server-generated (`<uuid>.media`); user filenames never reach a command or the filesystem.
- `-protocol_whitelist file` and a **forced demuxer** (`-f mov|matroska|avi`) chosen from the already-verified container: FFmpeg will not auto-detect HLS/concat/other demuxers that could read other files or URLs from inside an upload.
- stdin closed (`-nostdin`, `stdio: 'ignore'`), minimal environment (`PATH` only), stdout capped (4 MB), stderr drained and discarded (never logged or returned), `SIGKILL` on timeout.
- Output is parsed defensively; raw FFprobe JSON never crosses the API.

---

## 18. Extraction architecture (Checkpoint 3)

```
 MediaService (media ready)                             ┌─ shared pure domain (src/domain/extraction) ─────────────┐
        │ schedule(mediaId)                              │ MediaExtraction · AudioAsset · SubtitleTrack/Cue · Frame │
        ▼                                                │ lifecycle · cue normalisation · frame planner · validator│
 ProcessingQueue (extraction, default 1 job)             └──────────────────────────────────────────────────────────┘
        ▼
 MediaExtractionService  ── policy (selection, dedupe, limits, cleanup) ──►  MediaExtractor (port)
        │                                                                         ▲ implements
        ▼                                                                  FfmpegMediaExtractor ──► ffprobe / ffmpeg
 MediaStorage.withExtractionDir(id)   <uuid>.extraction/{audio,frames}/
```

- **Ports.** `MediaExtractor` offers four single operations (`inspect`, `extractAudio`, `extractSubtitleCues`, `sampleFrame`). The *application* decides what to extract and enforces policy; the *adapter* only knows how. Results are normalised values: no FFprobe JSON, command lines, stderr or paths cross the boundary.
- **Storage.** The application never sees a path. `MediaStorage.withExtractionDir` hands a workspace to the adapter inside a callback; assets are addressed by logical artifact names (`audio/aud-0.wav`, `frames/frm-00001.jpg`), validated against a strict pattern. `delete(id)` removes the original **and** the whole extraction directory.
- **Lifecycle.** Extraction is its own state machine (`not_started → queued → processing → completed | failed`) with phase-based progress (`preparing`, `extracting-audio`, `extracting-subtitles`, `sampling-frames`, `finalizing`). It is independent of media status and analysis status. If extraction fails, media stays `ready`.
- **Failure model.** Fatal issues (limits, timeout, unreadable media, invalid manifest) fail the extraction and delete every partial output. Non-fatal issues (one unreadable subtitle track, a frame with no picture, tracks beyond the track cap) complete the extraction with `errors[]` warnings: nothing is dropped silently.

## 19. Audio extraction

**Format decision: 16 kHz, mono, 16-bit PCM in WAV (`pcm_s16le`).**

| Option | For | Against |
| --- | --- | --- |
| **WAV PCM 16 kHz mono (chosen)** | Exactly what speech-to-text engines (Whisper and most others) consume; every tool reads it; no codec dependency; byte-deterministic with `-fflags +bitexact`; trivial to slice by time (bytes = 32,000 per second) | Large: about 115 MB per hour per track (can exceed the source file size) |
| FLAC | Lossless, about half the size | Needs a decoder step before use; more complex to slice |
| Opus/AAC | Tiny | Lossy; extra decode; non-deterministic across encoder versions; may reduce recognition accuracy |
| Original codec copy | Zero cost | Not uniform; consumers would need FFmpeg again |

Policy: **every** audio stream is extracted, in container order, up to `SAFEWATCH_AUDIO_MAX_TRACKS` (8); streams beyond the cap are reported as warnings, never dropped silently. Stream index, language, title, dispositions (default/forced/original/hearing-impaired/commentary) and source codec/sample rate/channels/bit rate are preserved. Multi-channel audio is down-mixed to mono. A stream whose decoded audio is **bit-identical** to an earlier one (SHA-256) is recorded with `duplicateOf` and its file is not stored twice. Zero audio tracks is valid (`audio: []`). Total audio output is bounded by one budget (`SAFEWATCH_AUDIO_MAX_MB`, default 512 MB) shared by all tracks: the expected size is checked before decoding, and the adapter enforces the remaining budget on the actual output (`-fs`). Audio-only files are **not supported**: ingestion rejects media without a video stream (`MEDIA_METADATA_FAILED`).

## 20. Subtitles

- **Detection** (FFprobe): index, language (ISO tag, `und` → null), title, codec, dispositions. Classification by codec: **text** (subrip, ass/ssa, webvtt, mov_text, and similar), **image** (hdmv_pgs_subtitle, dvd_subtitle, dvb_subtitle, xsub) or **unknown** (anything else, never assumed to be text).
- **Text extraction**: FFmpeg converts the stream to SubRip on stdout (capped at `SAFEWATCH_SUBTITLE_MAX_MB`); the pure `parseSrt` reads timing at millisecond precision; `normalizeCues` cleans the text.
- **Normalisation (documented transformations)**: formatting tags removed (`<i> <b> <u> <font…> <c> <v> <span>…` and ASS `{\an8}`/`{\i1}` overrides); literal ASS `\N` becomes a line break; the basic entities (`&amp; &lt; &gt; &quot; &nbsp;`) decoded; control, zero-width and bidirectional-override characters removed; each line trimmed and runs of spaces collapsed; blank lines dropped; text capped at 4,000 characters; empty cues, cues with invalid timing and exact duplicates (same start, end and text) dropped; cues ordered by start time. Words, punctuation, casing and timing are otherwise preserved. Non-formatting angle-bracket text such as `<laughs>` is kept. Output is **plain text** and is rendered as text by the UI.
- **Image subtitles**: listed with `kind: "image"`, `textExtraction: "unsupported"` and no cues. No OCR is performed. Unknown codecs are listed as `unsupported` the same way.
- A single track that cannot be read becomes `textExtraction: "failed"` plus a warning; it does not fail the whole extraction. Cue limit per track: 50,000.
- ASS styling, positioning and karaoke effects are not preserved (FFmpeg's SubRip conversion discards most of them).

## 21. Frame sampling

**Algorithm (pure, `planFrameTimestamps`).** `count = min(maxFrames, ceil(duration / interval))`, then the video is divided into `count` **equal** intervals and one frame is sampled at the **middle** of each: `t_i = (i + 0.5) × duration / count`, rounded to milliseconds. Mid-interval sampling avoids the usually black first frame and end-of-file seeks; equal division guarantees every timestamp lies inside the media (a previous formulation sampled past the end of short videos and was caught by a unit test). If `duration / interval` exceeds `maxFrames` the step grows so samples still span the whole video (a 3-hour video at 1 frame/s still yields at most `maxFrames`). The requested and effective intervals are both recorded. Unknown duration: only the first moment is sampled, with a `duration-unknown` warning.

**Method decision: one fast input-seek per frame** (`ffmpeg -ss T -i … -frames:v 1`), run sequentially.

| Method | Correctness / determinism | Cost |
| --- | --- | --- |
| **Per-timestamp seek (chosen)** | Exact requested times; independent frames; easy to cap and to clean up | N process launches; each decodes from the previous keyframe |
| Sequential decode with an `fps` filter | Timestamps follow decoder pts rounding | Decodes the **whole** video (minutes for long 4K/HEVC) |
| Keyframe-only (`-skip_frame nokey`) | Irregular spacing; not reproducible across encoders | Fast, but not controllable |
| Hybrid (seek + short decode window) | Same as chosen | More code for no measured need |

Measured (see the Checkpoint 3 report): 300 frames from a 1-hour 720p video in about 15 s. Cost grows with frame count and keyframe distance; the job timeout bounds the worst case. Requested timestamps are recorded; the decoded frame is the first at or after the seek point (within one frame period).

**Format decision: JPEG** (`-q:v 4`, `yuvj420p`).

| Format | Size | Compatibility | CPU |
| --- | --- | --- | --- |
| **JPEG (chosen)** | Small (about 6.9 MB for 300 synthetic frames; real content 20–60 KB per 768-px frame) | Accepted by every vision API and library | Lowest |
| WebP | Smaller | Not universal in model/tooling pipelines; slower encode | Higher |
| PNG | 5–20× larger | Universal | Higher, lossless not needed for analysis |

**Resolution.** Frames fit inside `maxWidth × maxHeight` (default 768×768), aspect ratio preserved, **never upscaled** (`scale='min(W,iw)':'min(H,ih)':force_original_aspect_ratio=decrease`). A 3840×2160 source yields 768×432 frames. Dimensions in the manifest are measured from the JPEG header, not assumed. Scene detection is **not** implemented; the sampler is isolated so a future `SceneDetector` can supply timestamps to the same plan.

## 22. Limits, concurrency and retention

| Limit | Default | Behaviour on breach |
| --- | --- | --- |
| Job timeout | 10 min | FFmpeg processes killed, extraction `failed: timeout`, partial output deleted |
| Concurrent extractions | 1 (queue of 20) | Beyond the queue: `failed: server-busy`; media stays ready |
| Frames per media | 300 | Planner caps the count (interval grows); never exceeded |
| Frame bytes per media | 64 MB total | `failed: limit-exceeded`, cleanup |
| Audio bytes per media | 512 MB total, 8 tracks | Estimated before decoding; enforced on output (`-fs`); `failed: limit-exceeded`, cleanup; extra tracks warned |
| Subtitle cues / bytes | 50,000 / 8 MB per track | Track marked `failed` + warning |
| Single FFmpeg step | 60 s | Aborted as `timeout` |

Within a job FFmpeg processes run **one at a time**; the default of one concurrent job therefore means at most one FFmpeg process (verified: peak concurrent = 1). Disk worst case per media item is about original + 512 MB audio + 64 MB frames; with the 60-minute retention and 4 concurrent uploads this is still unbounded without a volume quota (Checkpoint 11).

**Retention.** Original, extracted audio, subtitle data (inside the manifest, in memory) and frames share one clock: the original's 60 minutes (`SAFEWATCH_RETENTION_MINUTES`). `DELETE`, expiry, failure, timeout and startup/shutdown purge remove the original and `<id>.extraction/` together; an age-based sweep removes orphaned extraction directories. Running extractions are aborted before their media is deleted.

## 23. API

`GET /api/media/:id/extraction` → `{ extraction }` (`mediaId, status, phase, audio[], subtitles[], frames{config, effectiveIntervalSeconds, totalSizeBytes, frames[]}, createdAt, startedAt, completedAt, errors[], metrics{durationMs, stageMs, toolProcesses, outputBytes}`). 404 `NOT_FOUND` for unknown or malformed ids. `GET /api/media/:id` carries `extraction: {status, phase}` next to `asset` and `analysis`. No paths, no tool output, no raw FFprobe JSON. Artifact bytes are not served over HTTP yet; future server-side analysis reads them through `MediaStorage.readArtifact`.

## 24. Future AI boundary

```
 EXTRACTION (deterministic, Checkpoint 3)  ──►  NORMALISED ASSETS  ──►  FUTURE AI ANALYSIS (NOT implemented)
                                                 AudioAsset  (WAV 16 kHz mono, per track, language/title/dispositions)
                                                 SubtitleCue (start, end, plain text, per track and language)
                                                 Frame       (timestamp, size, JPEG artifact)
```

Future analysis code receives these values and reads artifact bytes through the storage port. It never needs FFmpeg commands, FFprobe JSON, subprocess objects or file paths. **No AI model is implemented in Checkpoint 3.**

## 25. Security status (unchanged gate)

All Checkpoint 2 controls apply to every extraction command (argv arrays, `shell: false`, minimal environment, closed stdin, `-protocol_whitelist file`, forced demuxer, timeouts, output caps, server-generated output names inside the job's directory with a path-escape guard, partial output removed on failure). Subtitle text and stream metadata are untrusted: sanitised, never logged, never interpreted as HTML. **FFmpeg isolation is still NOT COMPLETED** and remains a production security gate: there is still no OS sandbox, separate user, or memory/CPU cgroup. Measured example: decoding a 4K source made an FFmpeg child reach about 307 MB RSS with nothing limiting it.

---

## 26. Speech & subtitle intelligence (Checkpoint 4)

First AI inference in SafeWatch. It produces **text evidence only**: what was said or written, and when. It never decides whether media is safe, and it never mutes, hides or edits anything.

```
 MediaExtraction (completed)                               shared pure domain (src/domain/{speech,text})
   │ AudioAsset (WAV 16 kHz mono) · SubtitleTrack/Cue       Transcript · normalizeTranscription · selectAudioTracks
   ▼                                                        TextEvent · alignText · CustomFilter · findTextMatches
 TextAnalysisService  (bounded queue, default 1 job)        TextAnalysis lifecycle
   │ policy: track selection, limits, timeouts, cleanup
   ├─► SpeechToTextProvider (port) ◄── WhisperCppProvider ──► whisper-cli process ──► ggml model file
   │         raw, provider-neutral transcription (untrusted)
   ├─► normalizeTranscription + validateTranscript   → Transcript[]
   └─► eventsFromTranscript + eventsFromSubtitleTrack → buildTimeline → alignText → TextAnalysis.timeline
```

### 26.1 Provider evaluation

| Option | Accuracy / timestamps | Hindi & Indian-English | Apple Silicon / CPU | Install | Privacy | Cost | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **whisper.cpp** (Whisper family, native C++, ggml) | Whisper quality; segment times plus token times, optional DTW word alignment | Multilingual models; Hindi needs `small` (measured) | Metal and CPU out of the box, no Python or GPU needed | `brew install whisper-cpp` + one model file | Fully local | None | **Chosen** |
| faster-whisper (CTranslate2) | Same models, often faster on x86/CUDA; built-in word timestamps | Same | CPU only on Apple Silicon (no Metal) | Python venv, `ctranslate2` wheels, model download on first use | Local | None | Good on servers with GPUs; adds a Python runtime we do not need yet |
| OpenAI Whisper (PyTorch) | Reference quality | Same | Slower on CPU; heavy dependencies (torch) | Python + PyTorch | Local | None | Heaviest to run |
| Hosted STT API | Strong, often best accuracy | Strong | n/a | API key | **Audio leaves the machine** | Per-minute, grows with usage | Rejected for now: privacy and cost; the port makes it a later swap |
| Vosk / other local engines | Lower accuracy, weak punctuation | Limited | CPU | Model per language | Local | None | Not accurate enough for evidence |

**Decision:** whisper.cpp with the multilingual `ggml-base` model (141 MB, SHA-1 `465707469ff3a37a2b9b8d8f89f2f99de7299dac`, verified by `scripts/download-speech-model.sh`). It is the smallest model that is multilingual, runs about 16× faster than real time on this laptop, and needs no Python. **Python is not used at all**, so there is no Node/Python dependency tangle: the boundary is a single native executable behind `SpeechToTextProvider`. Only one provider exists; the port is what keeps it replaceable.

**Measured model comparison on this machine** (synthetic speech, see report): `base` transcribes English and Indian-accented English well but writes Hindi in **Urdu script** with word errors; `small` (465 MB, SHA-1 `55356645c2b361a969dfd0ef2c5a50d530afd8d5`, about 3× slower) writes Hindi in **Devanagari** nearly correctly. Neither handles Hindi-English code-switching. Use `small` for Hindi (`scripts/download-speech-model.sh small`); no code change is needed.

### 26.2 Runtime and setup

`whisper-cli` is spawned as a child process through the same hardened runner as FFmpeg: `spawn` with an argument array, `shell:false`, minimal environment, closed stdin, killed on abort. The only inputs on its command line are the server-generated audio path, the configured model path, a validated language code (`^[a-z]{2,3}$` or automatic) and fixed flags; **no user text, transcript or filter phrase ever reaches a command**. Output goes to a private temp directory (JSON) that is always deleted; stdout/stderr are discarded; the output file is size-capped. A corrupt audio file makes whisper.cpp exit 0 **without writing output**, which the adapter treats as `unsupported-audio`. Each job loads the model afresh (about 0.3 s for `base`); a resident server process is a later optimisation.

Setup: `brew install whisper-cpp` (installs `whisper-cli`), `scripts/download-speech-model.sh`, then in `.env`: `SAFEWATCH_SPEECH_PROVIDER=whispercpp`, `SAFEWATCH_SPEECH_MODEL_PATH=models/ggml-base.bin`. `models/` is git-ignored. If the binary or model is missing the server still starts, reports `speech.available: false` in `/api/health`, and collects subtitle evidence only.

### 26.3 Audio track selection policy

Input is the `AudioAsset` produced by extraction; the speech layer never extracts audio. Candidates are tracks with a stored file (bit-identical duplicates are listed as `duplicate`). Ranking, highest priority first: (1) language: matches the configured language, then unknown, then other (only when a language is configured; container tags such as `eng` map to `en`); (2) the container's default track; (3) not a commentary / hearing-impaired track; (4) container order. `SAFEWATCH_SPEECH_MAX_TRACKS` (default 1) tracks are transcribed; **every other track is listed with a reason** (`not-selected`, `duplicate`, `speech-disabled`), never dropped silently. Each result carries the track id, stream index and container language.

### 26.4 Transcript model and timestamps

`Transcript { mediaId, audioTrackId, streamIndex, language, languageConfidence, durationSeconds, segments[], hasWordTimestamps, wordTiming, provider, issues[] }`; a segment is `{ index, startSeconds, endSeconds, text, originalText, confidence, words[]|null }`; a word is `{ startSeconds, endSeconds, text, confidence }`.

- **Unit and precision:** media time in seconds, rounded to whole milliseconds (the engine reports 10 ms steps). No frame numbers anywhere.
- **Normalisation (deterministic):** NFC, control/zero-width/bidi characters removed, whitespace collapsed; the provider's text is kept as `originalText` only when it differed. Segments with missing, non-finite, negative or inverted times are dropped and counted; empty segments and exact duplicates are dropped; overlapping segments are kept untouched and counted; word lists that are out of order or outside their segment are discarded for that segment (`words: null`, counted). Words, casing and punctuation are never "corrected".
- **Confidence:** the mean of the engine's token probabilities for the word or segment. It is a model probability, not a calibrated confidence, and is `null` when the provider supplied none. Subtitles have no confidence.
- **Language:** the detected language (two-letter code) is recorded per transcript. Speech is never translated. Whisper reports one language per track.
- **Word timing basis (`wordTiming`):** `alignment` uses whisper.cpp's DTW alignment (`-dtw <preset> -nfa`); `decoder` uses the engine's own token times. **Measured on a clip with known ground truth** (2.0 s of leading silence, then speech, a 1.5 s pause, more speech): without DTW the first word was placed at 0.00 s (**2.0 s early**); with DTW the first word started at 2.08 s and the second sentence at 5.40 s vs a true 5.32 s (errors ≈ +0.08 s). DTW is therefore the default. **Word START times are the reliable part. A word's END is an upper bound** (the next word's start; the last word of a segment is capped at +1.0 s), and neighbouring words can share a start time. Do not use word ends as exact mute boundaries without further work.

### 26.5 Text events, alignment and custom filters

- **TextEvent** (`source: speech | subtitle`, start, end, text, language, trackId, confidence, words, evidence) is the common shape; subtitle events come from the extraction cues of **text** tracks only (image and failed tracks contribute none).
- **Alignment** is deterministic and conservative: a speech event and subtitle cue(s) are linked only if they are within 1 s in time, in compatible languages (by primary language; `eng` = `en`), and their words overlap (Dice similarity ≥ 0.6). It compares a speech event with all nearby cues together (cues split sentences) and a cue with several speech segments. Result per event: `both`, `speech-only` or `subtitle-only`. *No link means "not corroborated", never "wrong"*. No semantic AI.
- **CustomFilter** `{ id, phrase, normalizedPhrase, matchMode, enabled, createdAt }`. **Normalisation for matching:** NFKC, control/zero-width/bidi removed, curly quotes/apostrophes straightened, whitespace collapsed, optional lower-casing; punctuation is dropped by word tokenisation (inner apostrophes kept); diacritics are **not** stripped (“résumé” ≠ “resume”) and non-Latin scripts are preserved. **Modes:** `exact` (case-sensitive substring), `case-insensitive` (substring, may match inside words), `word-boundary` (whole words, case-insensitive), `phrase` (whole words ignoring spacing/punctuation between them, so “SafeWatch” matches the speech model's “safe watch”).
- **TextMatch** `{ filterId, phrase, source, trackId, eventId, startSeconds, endSeconds, matchedText, confidence, granularity (word|segment|cue), matchMode }`: word-level times when word timestamps exist, otherwise the whole segment/cue (honestly labelled). Confidence is the lowest known confidence of the matched words, `null` if unknown or for subtitles. Matching is pure, bounded (10,000 matches) and treats phrases as plain text (no regular expressions are built from user input). Filters live in the user's browser (localStorage) and matching runs there; filters are never sent to the server.
- **Not implemented:** muting, beeping, blurring, censoring, subtitle replacement, scene skipping, scoring, any "safe/unsafe" verdict. Matches are evidence the future filtering engine will consume.

### 26.6 Lifecycle, API, limits

`TextAnalysis { status: not_started | queued | processing | ready | failed, phase: preparing | speech-processing | building-timeline }` runs after extraction completes, on its own bounded queue (default 1 job, queue of 20). `ready` means "text evidence is available", not "analysis is complete"; the safety `analysis` state stays `not_started`. A failed track (provider error, timeout, limit, unsupported audio) fails **that track only**, with a structured code, and the rest of the evidence is kept; the whole analysis fails only for queue overflow, cancellation or an internal error. `GET /api/media/:id/transcript` returns the `TextAnalysis` (`?words=false` omits word timestamps); `GET /api/media/:id` carries `text: {status, phase}`; `/api/health` reports `speech: {provider, available}` only.

| Limit | Default | On breach |
| --- | --- | --- |
| Per-track transcription timeout | 10 min | engine killed, track `failed: timeout` |
| Audio duration per track | 3600 s | track `failed: resource-limit`, engine not started |
| Audio size per track | 256 MB | same |
| Concurrent transcriptions | 1 (queue of 20) | beyond the queue: text analysis `failed: server-busy` |
| Tracks per media | 1 | others listed as `not-selected` |
| Transcript size | 20,000 segments, 2,000 characters per segment, 64 MB engine output | truncated and counted / `resource-limit` |

Cancellation: deleting media or expiry aborts the in-flight transcription (the engine process is killed, its temp directory removed) before the media is removed. A restart discards all transcripts with the media (in-memory, same retention).

### 26.7 Privacy

- **Where audio is processed:** on the SafeWatch server machine, by a local whisper.cpp process. **Audio is not sent to any third party**; the engine has no network access requirement and none is used (the model is a local file). The only network use is the one-time model download from Hugging Face by the developer.
- **Where transcripts live:** in server memory (inside the media record) and in API responses; never logged (logs hold counts, durations, ids and codes only). Subtitle text likewise. **One exception on disk:** whisper.cpp writes its result JSON (containing the transcript) into a private temp directory (created with mode 0700, verified by a test) which is deleted as soon as the adapter has read it and on every failure/abort path; if the server crashes mid-run that directory can survive until the next start, when stale `sw-whisper-*` directories older than an hour are swept. Audio itself is read in place from the media's extraction directory and is not copied.
- **Retention:** the media's 60-minute clock; deleting or expiring media deletes its transcripts and timeline, and aborts transcription in progress. The engine's temporary JSON is deleted immediately after each run.
- **Browser:** custom filters are stored in the visitor's own browser; transcripts are fetched on demand and are not persisted by the page.
- **Not claimed:** the machine hosting SafeWatch can read whatever it processes; encryption at rest, access control and per-user isolation do not exist yet (no authentication).

---

## 27. Visual intelligence (Checkpoint 5)

Second AI inference in SafeWatch. It produces **visual evidence only**: what an image model reports about each sampled frame, and when. It never decides whether media is safe, and it never mutes, blurs, hides, skips or edits anything. There is no safety classification, no score and no verdict anywhere in the model, the API or the UI.

```
 MediaExtraction (completed)                                   shared pure domain (src/domain/{vision,evidence})
   │ Frame { id, timestampSeconds, artifact }                   VisualObservation · normalizeObservation · compareObservations
   ▼                                                            VisualAnalysis lifecycle · validateVisualAnalysis
 VisualAnalysisService  (bounded queue, default 1 job)          EvidenceItem · buildEvidenceTimeline (text + visual on one timeline)
   │ policy: limits, batches, timeouts, cancellation, isolation
   ├─► VisualAnalysisProvider (port) ◄── AppleVisionProvider ──► safewatch-vision process ──► Apple Vision framework
   │         raw per-frame observations (untrusted)
   └─► normalizeObservation → sort → VisualAnalysis { frames, observations, counts, issues, metrics }
```

### 27.1 Provider evaluation (measured on this Apple Silicon Mac)

| Option | Output | Footprint | Privacy | Verdict |
| --- | --- | --- | --- | --- |
| **Apple Vision** (system framework, Swift helper) | Labels with confidence, person/animal boxes, OCR with boxes | 169 KB helper, no model download, ~70 MB RSS while running | Fully local | **Chosen** |
| ONNX Runtime (npm) + a model | Whatever the model gives | 145 to 301 MB of runtime before any weights | Local | Heavier; the right Linux adapter later |
| llama.cpp vision-language model | Free text only; no confidences or boxes | Gigabytes of weights | Local | Not evidence-shaped |
| CLIP-style embeddings | Similarity scores to prompts | ~350 MB | Local | Needs prompt lists: that is classification by another name |
| YOLO family | Object boxes | Small | Local | AGPL licence |
| Hosted vision API | Strong | None locally | **Frames leave the machine** | Rejected: privacy and cost |

**Trade-offs, stated plainly:** macOS only, and the model is Apple's and closed (no weights to inspect or pin). The port is what keeps it replaceable. Observed quirks: a person was missed in a living-room photo; a pure black frame is labelled "outdoor / night sky" (0.51); OCR can crop edge characters; the label vocabulary is Apple's ("consumer_electronics", "wood_processed"). **Face detection and recognition are deliberately not used.**

### 27.2 Contracts

- `VisualObservation { id, frameId, frameIndex, timestampSeconds, type, label, confidence | null, region | null, attributes | null, provider, model }`. Types are only `classification`, `object`, `text`: there is no safety type. Time always comes from the frame (media time); providers never supply it. Confidence is the provider's own number or `null` (never invented, out-of-range becomes `null`). Regions are fractions of the image with a **top-left origin** (the helper converts from Vision's bottom-left); invalid regions are removed, the observation stays.
- Order is total and deterministic: time, frame index, type (objects, text, labels), confidence (high first), label, id.
- `VisualAnalysis` has its own lifecycle `not_started → queued → processing → ready | failed`, separate from media, extraction and text. `ready` means "visual observations are available". Every candidate frame is listed with `analyzed | failed | skipped` and a reason.
- **Error taxonomy** (which layer failed): `frame-missing` (storage/extraction), `invalid-frame` (not a decodable JPEG/PNG), `inference-failed`, `provider-unavailable`, `timeout`, `cancelled`, `invalid-response` (provider output unusable), `resource-limit`, plus `no-frames`, `observations-dropped`, `server-busy`.
- **Failure isolation:** one bad frame fails alone; a failed batch fails only its frames; if nothing could be analysed the stage fails with the dominant cause; media and extraction stay `ready/completed`.

### 27.3 Unified evidence (decision)

`src/domain/evidence` projects `TextEvent` (speech, subtitles) and `VisualObservation` into one `EvidenceItem` shape and one chronological list, so later stages can ask "what was said, written and shown around t". It is a pure projection: **nothing in the speech, subtitle or Custom Filter code changed, and nothing consumes it yet.** Custom Filters still match text only.

### 27.4 Security and privacy

Frames are untrusted media: the helper opens only JPEG/PNG (type checked by the image decoder), oversized frames are refused before decoding, a corrupt file fails alone. The helper is run with an argv array (no shell), frame paths are server-generated and passed after `--`, the environment is minimal, stdin is closed, stdout is capped, stderr is discarded and the process is killed on timeout or cancellation. Labels and OCR text are sanitised, rendered as text, never as HTML, and never logged. `/api/frames` serves only ids from the manifest, as `image/jpeg` with `nosniff` and `default-src 'none'`. Frames and observations live for the same retention window as the media; nothing is uploaded anywhere.

**Unchanged production gates (NOT solved):** FFmpeg and helper process sandboxing, authentication/authorisation (media ids are bearer tokens, and frame images are reachable by id), rate limiting, disk quota.

### 27.5 Performance baseline

See `CHECKPOINT_5_REPORT.md`. Measured warm on this machine: about 36 ms per 640×480 frame, 300 frames in about 10.7 s of provider time, helper about 70 MB RSS. The first-ever run took about 26 s (system model compilation). These are small-frame, repeated-photo numbers, not a general benchmark.
