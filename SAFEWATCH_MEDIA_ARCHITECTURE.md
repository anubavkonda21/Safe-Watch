# SafeWatch Media Architecture

Status: decided in Checkpoint 1. Only the client-side contract is implemented; the server is introduced in Checkpoint 2 (see §5, §12).

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
