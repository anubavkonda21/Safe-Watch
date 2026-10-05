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
