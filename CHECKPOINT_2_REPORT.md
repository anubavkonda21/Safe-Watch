# CHECKPOINT 2 REPORT — Node API, Secure Upload, FFmpeg/FFprobe & Server Processing Foundation

## 1. Starting Git State
Verified before any change: branch `main`; working tree clean; `origin` = `https://github.com/anubavkonda21/Safe-Watch.git`; local `HEAD`, `origin/main` and `git ls-remote` all `e2871134467de04a130f1cbce7af257771fea688` (`feat: establish SafeWatch media ingestion foundation`).

## 2. Environment
| Tool | Result |
| --- | --- |
| OS / CPU / RAM | macOS 27.0.1, arm64, 16 GB |
| Node / npm / Git | v24.21.0 / 11.19.0 / 2.54.0 |
| Homebrew | 7.0.7 (already installed) |
| FFmpeg / FFprobe (before) | not installed |
| Docker | not installed (not needed, not installed) |
| Python | 3.14.6 (unused by the product) |

## 3. FFmpeg Installation
Installed **yes**, with the already-present Homebrew: `brew install ffmpeg` (default formula; Homebrew also installed its own library dependencies). Verified: `ffmpeg version 9.0.2`, `ffprobe version 9.0.2`; encoders libx264/libx265/libvpx/aac present. Docker and Homebrew itself were not installed. Production strategy is documented in `SAFEWATCH_MEDIA_ARCHITECTURE.md` §16 (local: package manager; production now: system package on the API host; scaling: hardened Docker image; managed service rejected for privacy/cost) and **production isolation is NOT solved** (see §18).

## 4. Architecture
```
 Browser (React SPA)
   │  File ─ client validation (ext + MIME + size + signature) ─ XHR raw body (real progress)
   ▼
 Vite dev proxy / reverse proxy (same origin; CORS allow-list otherwise)
   ▼
 ┌──────────────── Node API (server/) ────────────────────────────────────────────────┐
 │ api/            HTTP only: routing, CORS, request id, error rendering               │
 │    ▼                                                                                  │
 │ application/    MediaService (upload, get, delete, sweep) · ProcessingQueue          │
 │                 ports: MediaStorage · ServerMediaProcessor · MediaRepository · Logger │
 │    ▼                                                                                  │
 │ domain/         MediaRecord + transitions        shared: src/domain (MediaAsset,     │
 │                                                  validation, sniffing, contract,     │
 │                                                  AnalysisJob boundary)               │
 │    ▲ implements ports                                                                 │
 │ infrastructure/ LocalDiskMediaStorage · FfmpegMediaProcessor (ffprobe/ffmpeg)        │
 │                 InMemoryMediaRepository · JsonLogger                                  │
 └──────────────────────────────────────────────────────────────────────────────────────┘
                         │                      │
                 temp dir (0700)        spawn(argv[], shell:false)
              <uuid>.part → <uuid>.media     ffprobe / ffmpeg
```
- **Frontend:** existing app + `MediaUploader` port, `HttpMediaUploader` (XHR + polling), state machine extended with upload phase/progress and analysis status.
- **Backend location (decision):** `server/` in the same repo; it imports the pure `src/domain` directly, so nothing is duplicated. No framework: `node:http` only. Documented in the architecture doc §14.
- **FFmpeg boundary:** only `FfmpegMediaProcessor` knows FFmpeg; the application depends on `ServerMediaProcessor`, which extends the shared `MediaProcessor<TSource>` port (made generic: `File` in the browser, `{path, container}` on the server).

## 5. API
| Endpoint | Behaviour |
| --- | --- |
| `GET /api/health` | `{status ok|degraded, service, version, environment, tools:{ffmpeg,ffprobe}}`. No paths, secrets or versions of tools |
| `POST /api/media` | Raw body; `X-SafeWatch-Filename` (URI-encoded), `Content-Type`. **202** `{media:{asset,analysis}}` + `Location` |
| `GET /api/media/:id` | `{media}`; 404 `NOT_FOUND` for unknown/malformed ids |
| `DELETE /api/media/:id` | 204, idempotent |
Errors: `{error:{code,message,requestId}}`; codes INVALID_FILE 400, UNSUPPORTED_MEDIA 415, FILE_TOO_LARGE 413, UPLOAD_FAILED 400, MEDIA_PROCESSING_FAILED 500, MEDIA_METADATA_FAILED 422, STORAGE_FAILED 500, PROCESSING_TIMEOUT 504, SERVER_BUSY 503 (+`Retry-After`), NOT_FOUND 404, INTERNAL_ERROR 500. Messages are fixed strings; asynchronous failures appear on the asset as `failure.code`.

## 6. Upload Flow
1. Browser validates (extension, MIME, size, magic bytes) and creates a local `accepted` asset.
2. XHR `POST` of the `File` as the raw body (streamed from disk by the browser; progress events are real).
3. Server cheap checks before reading bytes: filename header, MIME allowlist, extension allowlist, declared `Content-Length` vs limit, concurrent-upload and queue capacity.
4. Body streams → signature check on the first 64 bytes *during* streaming → `<uuid>.part` with byte limit and upload deadline → atomic rename to `<uuid>.media`.
5. Record `uploaded`; **202** returned with the id; job queued.
6. Queue slot → `processing` → FFprobe metadata + FFmpeg decode check under a timeout → `ready` (or `failed`, file deleted).
7. Client polls `GET /api/media/:id` every 500 ms until `ready`/`failed`, then shows **Media: ready / Analysis: not started** (or a mapped error).

## 7. Storage
`MediaStorage` port: `save` (streaming), `exists`, `read`, `withLocalFile`, `delete`, `cleanup(olderThan)`, `purge`. Local-disk adapter: dedicated directory (0700) with marker file, files 0600, ids validated as UUIDs, only `<uuid>.(media|part)` names ever touched. **Lifecycle:** created at upload start (`.part`) → published on completion → kept while `ready` → deleted on `failed` (immediately), on `DELETE`, after `SAFEWATCH_RETENTION_MINUTES` (60), by an age-based sweep (also catches files whose delete failed), and by a full purge at startup and graceful shutdown. Records are in memory, so a crash loses them and the startup purge removes the now-unreferenced files.

## 8. FFprobe
Args (fixed, argv array): `-v error -hide_banner -protocol_whitelist file -f <forced demuxer> -print_format json -show_format -show_streams -i <server-generated path>`. Output is reduced to: duration, first non-cover video stream (codec, width, height, frame rate from `avg_frame_rate`/`r_frame_rate`), first audio codec, `hasAudio`, `hasSubtitles`, normalised through the shared `normalizeMetadata` into `MediaMetadata` with `source: "ffprobe"`. Container format is exposed as `asset.container`/`typeLabel` (from the verified signature). No video stream, no usable dimensions, non-zero exit or unparseable JSON → `invalid-media`. Raw FFprobe JSON never leaves the server.

## 9. FFmpeg
`FfmpegMediaProcessor.verifyDecodable`: `ffmpeg -nostdin … -t 2 -map 0:v:0 -an -sn -dn -threads 1 -f null -` proves the start of the video stream decodes. Current scope is only metadata + this decode smoke test. **Not built:** audio extraction, subtitle extraction, frame sampling (next checkpoint).

## 10. Security
- **Validation (server, independent of the browser):** extension allowlist (`Object.hasOwn`, so `a.constructor` is rejected), MIME allowlist, container signature must match extension, size enforced by declared length *and* while streaming, FFprobe structure check, decode check.
- **Path safety:** storage names are server UUIDs only; user filename is sanitised (NFKC, separators, bidi/zero-width/control, shell metacharacters) for display and never touches disk or a command; storage rejects non-UUID ids and refuses foreign non-empty directories.
- **Command execution:** `spawn` with argv array, `shell:false`, stdin closed, `PATH`-only environment, 4 MB stdout cap, stderr discarded, `SIGKILL` on timeout/abort, `-protocol_whitelist file`, forced demuxer (blocks HLS/concat redirection tricks; tested with a disguised playlist).
- **Limits:** max upload size, upload deadline (30 min), processing timeout (60 s), `maxConcurrentUploads` (4), `maxConcurrentProcessing` (2) with bounded queue (20) → `503 SERVER_BUSY`, header timeout 15 s, request timeout.
- **CORS:** explicit exact-origin allow-list (`*`, paths and malformed origins rejected at startup); no credentials; disallowed origins get no CORS headers (preflight 403). Development avoids CORS via the Vite proxy. Production policy: same origin behind a reverse proxy, or list the SPA origin explicitly.
- **Errors/logging:** fixed safe messages, request id on every response; JSON logs contain request id, media id, operation, status, duration only (tested: filenames are not logged).
- **Not done:** authentication/authorisation (media ids are unguessable UUIDs but act as bearer tokens; anyone can upload within limits), per-client rate limiting, TLS (needs a proxy), OS-level sandboxing of FFmpeg.

## 11. Cleanup
Every path is covered by a test: oversized (declared and streamed), invalid signature, empty body, client disconnect, upload deadline/abort (partial `.part` removed); processing failure and timeout (file deleted, record kept as `failed`); explicit `DELETE`; expiry sweep; failed delete retried by the age-based sweep; startup purge; foreign directory refused. Graceful shutdown purge was exercised manually (SIGTERM → no media files left); a hard crash was only *simulated* (leftover files purged at next start).

## 12. Frontend
`HttpMediaUploader` (XHR for real progress, filename header, polling, typed error mapping including gateway 502/503/504 without a JSON body → "server unreachable"), `MediaUploader` port, `createMediaIngestion` accepts a processor *or* an uploader, `VITE_MEDIA_BACKEND=server|browser` and `VITE_API_URL`. UI: determinate "Uploading your video N%" (never fabricated: starts at 0% and only real events move it), indeterminate "Preparing your media...", **Media ready** with `MEDIA: READY` and `ANALYSIS: NOT STARTED` badges, a fact list (type, size, duration, resolution, frame rate, codecs, audio, subtitles) and honest copy that the file was uploaded and stored temporarily. New error copy for upload-failed, server-busy, server-unreachable. The previous upload is released (`DELETE`) when replaced. No new colors, spacings or radii.

## 13. Performance (measured on this machine, loopback)
| Measure | Result |
| --- | --- |
| Server startup | 37 ms to "listening" (dev, in-process); **87 ms** from process spawn to first successful `/api/health` (production bundle, includes Node boot and FFmpeg check) |
| Small real video (10 KB MP4, 1 s, H.264+AAC) | upload 4 ms; FFprobe + decode check 68 ms |
| 95 MB real MP4 via browser (through the Vite proxy) | ~80 ms upload; ready after ~0.6 s (dominated by the 500 ms poll interval) |
| Cleanup | delete of a 1.4 GB file: 22 ms (in-process), 40 ms (HTTP, separate process) |
| Frontend bundle | JS **288.31 kB (91.66 kB gzip)**, CSS 18.08 kB (4.52 kB gzip). Checkpoint 1: 282.47 kB (89.56 kB gzip) / 17.93 kB. **+5.84 kB (+2.10 kB gzip)** |
| Server bundle | `dist-server/main.js` 39.87 kB (13.41 kB gzip), no runtime npm dependencies |
| Dependencies added | **one**: `tsx` (devDependency, runs TypeScript in development). No runtime dependency |

## 14. Large File Test
Real H.264/AAC MP4, 1920×1080@30, **1,504,590,072 bytes (1,434.9 MB)**, generated with FFmpeg *outside* the repository (`/tmp`, not committed). Reproducible with `npm run check:large -- <file>`.
| | In-process (real storage + real FFprobe) | Production bundle, separate process (curl `-T` upload) |
| --- | --- | --- |
| HTTP result | 202 → `ready`, 1920×1080, 30 fps, 300 s, h264/aac | 202 → `ready` |
| Upload time | 0.7 s (≈2 GB/s, loopback + page cache) | 0.43 s |
| Processing (FFprobe + decode) | 164 ms | 90 ms |
| Heap | 9.3 MB → peak 11.7 MB (**+2.4 MB**) | n/a |
| RSS | 89.6 → peak 171.3 MB (+81.6 MB, includes the test client's read stream) | 63.5 MB idle → peak **100.4 MB (+37 MB)** |
| Stored file | 1 file during, **0 left** after DELETE | 1,434.9 MB on disk, **0 left** after DELETE and after shutdown |
Conclusion supported by the data: a 1.4 GB upload does not scale Node heap or RSS with file size (memory growth ≈ 2.5% of the file). **Not tested:** concurrent large uploads, a slow real network, non-faststart MP4s (moov atom at the end), files above 2 GB, Linux. Note: the first attempt used `curl --data-binary`, which buffers the whole file client-side and failed; that was a curl limitation, not the server.

## 15. Tests
`npm test` (Vitest, two projects): **246 passed, 0 failed, 0 skipped** (web 140 in 14 files, server 106 in 8 files). Repeated runs were used to find flakiness (about 40 full-suite runs, 1 failure in 24 consecutive runs): one flaky server test (a `.part`-file timing assumption in the test, not in the product) was found and fixed, then the server project passed 40 consecutive runs.
- API: health (ok/degraded, request ids), valid upload → ready, no path/tool leakage, missing/undecodable filename, empty body, invalid MIME, invalid extension (incl. prototype keys), wrong content, oversized (declared and chunked), disconnect, unknown routes, malformed media (real FFprobe), unexpected processor error, processing timeout (abort observed), SERVER_BUSY, concurrent-upload limit, generic 500, DELETE, 404s, CORS (allowed/denied/preflight, never `*`).
- Storage: write/read/exists/delete, permissions, `.part` → `.media`, too-large, source failure, abort, traversal ids, `withLocalFile`, age cleanup, purge, foreign directory.
- FFprobe/FFmpeg (real binaries): MP4+audio, MKV with subtitles, silent WebM, truncated, garbage behind valid header, wrong container, missing file, decode check, abort, missing binary, disguised playlist, tool check; pure normalisation and argv construction tests.
- Domain/security: server record transitions (legal and illegal), analysis lifecycle, hostile filenames end to end (traversal, backslashes, absolute, shell metacharacters, bidi, null byte, fullwidth lookalikes), logs contain no filenames; process runner (no shell, minimal env, closed stdin, abort, output cap).
- End-to-end (3 tests): HTTP upload → disk → real FFprobe/FFmpeg → `MediaAsset` → DELETE → disk empty (MP4, MKV with subtitles, truncated).
- Frontend: uploader (progress, mapping, polling, timeouts, gateway errors, abort), ingestion service with an uploader, state machine (progress, phases, analysis), UI (real progress states, no fabricated percentages, server error mapping, replace → `DELETE`), config.
Note: FFmpeg-dependent tests skip themselves when FFmpeg is absent (none skipped here).

## 16. Build
`npm run build` (tsc + vite): succeeded; `dist/` JS 288.31 kB, CSS 18.08 kB. `npm run build:server` (vite SSR): succeeded; `dist-server/main.js` 39.87 kB. `npm run lint` clean; `npm run typecheck` clean (covers `src`, `server`, `scripts`).

## 17. Visual Verification (real browser, real API, real uploads)
Widths **320, 375, 768, 1024, 1280, 1440**: no horizontal overflow at any (`scrollWidth == innerWidth`); upload zone 288 px at 320 (full width), 343 px at 375, 680 px from 768 up; nav toggle hidden at 768+. A real upload completed at every width (MP4 at 320/768/1024/1280/1440, MKV with embedded subtitles at 375, a 95 MB MP4 for progress). Checked: filename wrapping (a 90-character name at 320), metadata facts, status badges, buttons, nav. Progress verified through a 25 MB/s throttling proxy: 36 distinct monotonic values 0→98 % over 3.7 s, then "Preparing your media...". Error states verified in the real UI: server-side malformed media → "does not look like a valid video"; API down behind a gateway → fixed to "server unreachable" after this test exposed a mapping gap. Screenshots reviewed at 320 (ready), mid-upload (42 %) and 1440 (ready). **Not visually re-checked at every width:** the error and uploading states (verified by DOM/text, screenshots only at the widths above).

## 18. Known Limitations
- No authentication or per-client rate limits; a media id is a bearer token. `DELETE` is unauthenticated.
- State is in memory: a restart discards all media and records (by design, but it means no resumable work).
- Polling (500 ms) instead of push; adds up to 0.5 s latency.
- Early rejections (e.g. 413 by declared length) close the connection while the client may still be sending; a browser may then see a network error instead of the JSON body (client-side limits normally prevent this; **not tested in a real browser**).
- CORS is covered by tests, **not exercised from a real cross-origin browser** (development uses the same-origin proxy).
- The decode check covers only the first 2 seconds; later corruption is not detected. Header/signature checks cannot prove a file is benign.
- Only MP4/MOV/M4V, MKV/WebM and AVI are accepted; other containers (MPEG-TS, OGG, FLV) are rejected.
- No reverse proxy/TLS/deployment configuration was created; the Vite proxy is development only.
- Tests that need FFmpeg are skipped when it is missing.
- Roadmap numbering shifted by one (the original Checkpoint 2 scope was split; extraction moved to Checkpoint 3).

## 19. Architecture Risks
1. **FFmpeg parses untrusted input in the API process.** Mitigated by forced demuxers, protocol whitelist, timeouts and caps, but there is no OS sandbox, memory/CPU cgroup or separate user. Highest-priority risk for Checkpoint 11.
2. **Single-process, in-memory design** does not scale horizontally and loses state on restart; moving to a queue/DB needs the ports already present.
3. **No auth/abuse protection** beyond global concurrency caps: a single client can occupy all slots.
4. **Disk exhaustion:** limit × concurrent uploads × retention can fill the volume (4 × 2 GB per 60 min by default); no quota/free-space check.
5. **FFmpeg version drift** between environments (no pinning yet).
6. **Retention vs. privacy:** originals are kept up to an hour so later stages can use them; the product must decide the final data policy.
7. Raw-body upload is not resumable; a dropped 2 GB upload starts over.

## 20. Future Checkpoint
Checkpoint 3 should build **media extraction** on this foundation, still without AI: audio extraction (FFmpeg → normalised audio file with duration/timestamps), embedded-subtitle detection and extraction (SRT/ASS/WebVTT parsing with timestamps), controlled frame sampling with timestamps, artefact lifecycle in `MediaStorage`, and an `AnalysisJob` skeleton that consumes them. Speech-to-text and subtitle intelligence follow once those artefacts are stable. Decide first: retention policy for originals and derived artefacts, and whether to add authentication before real users upload.

## 21. Git
- Commit message: `feat: add server media processing foundation` (hash reported in the final message; a commit cannot contain its own hash)
- Remote: `origin` → `https://github.com/anubavkonda21/Safe-Watch.git`, normal push to `main`, no force
- Working tree after commit: clean
