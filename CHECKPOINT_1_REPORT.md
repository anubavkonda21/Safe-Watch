# CHECKPOINT 1 REPORT — Media Ingestion Architecture & Upload Pipeline

## 1. Starting State
- Commit `ae398c85a12c2d38230975f5cc2c68429771417d` (`feat: initialize SafeWatch product foundation`)
- Branch `main`, tracking `origin/main`
- Remote `origin` = `https://github.com/anubavkonda21/Safe-Watch.git`
- Working tree clean (verified before any change)

## 2. Environment
| Tool | Result |
| --- | --- |
| Node | v24.21.0 |
| npm | 11.19.0 |
| Git | 2.54.0 |
| FFmpeg | not installed |
| FFprobe | not installed |
| Python | 3.14.6 (unused) |
| Docker | not installed |
| Machine | macOS, arm64, 16 GB RAM |

Nothing was installed in this checkpoint.

## 3. Architecture Options
A browser-only; B Vite + Node/TypeScript API running FFmpeg; C dedicated media service; D managed/cloud processing; E desktop wrapper. Full 14-criterion comparison table in `SAFEWATCH_MEDIA_ARCHITECTURE.md`.

## 4. Architecture Decision
**Option B, phased.** SPA + Node/TypeScript API that invokes system FFmpeg/FFprobe (argument arrays, no shell), local-disk storage and an in-process job queue behind ports. Checkpoint 1 builds only the client-side contract; the server arrives at the start of Checkpoint 2.

## 5. Why
Audio extraction, embedded subtitles, frame sampling and broad codec support need real FFmpeg; AI provider keys must be server-side. B is the smallest architecture that provides that. C/D add operations or cost with no current load, and processing behind `MediaProcessor` keeps C reachable. The server was not built now because FFmpeg is not installed, so it could not be verified here.

## 6. Media Pipeline (implemented)
```
File → validateMediaFile (extension allowlist, MIME allowlist, empty, size)
     → read first 64 bytes (File.slice) → detectContainer → must match extension
     → MediaAsset(accepted) → MediaProcessor.extractMetadata → MediaAsset(ready)
```
`createMediaIngestion` (application) exposes `accept` and `prepare`; the React hook `useMediaIngestion` drives the state machine and discards results from superseded runs.

## 7. Domain Model
- `MediaAsset`: id (UUID), filename (sanitised), mimeType (canonical, from detected container), container, typeLabel, sizeBytes, status, metadata, createdAt (ISO), failure.
- `MediaMetadata`: availability (`pending | available | partial | unavailable`), source, unavailableReason (`unsupported-by-browser | timeout | malformed`), durationSeconds, width, height, frameRate, videoCodec, audioCodec, hasAudio, hasSubtitles. **`null` means unknown, never "absent"**; the browser adapter cannot know codec, frame rate, audio or subtitles, so those stay `null`.
- Asset status: `accepted | processing | ready | failed`. Session states `idle` and `validating` live in the ingestion state machine because no asset exists before validation succeeds (a deliberate departure from the sample model, so one status does not mean two things).
- Typed errors (`MediaIngestionError.code`): `unsupported-type`, `file-too-large`, `empty-file`, `invalid-media`, `processing-failed`, `timeout`, `storage-failure`. `timeout` and `storage-failure` are defined for the server adapter and are not raised by the browser adapter today.

## 8. Upload
- Type: extension allowlist **and** MIME allowlist **and** content signature (MP4/MOV, Matroska/WebM, AVI) that must be plausible for the extension. Empty MIME is allowed (browsers omit it for MKV/AVI) because the signature check covers it.
- Size: single configurable limit (`VITE_MAX_UPLOAD_MB`, default 2048), read from `config` only.
- Filename: NFKC-normalised first, path segments, control, bidi, zero-width and shell metacharacters removed, length capped; used for display only.
- **Invalid vs unreadable:** a valid file whose details the browser cannot read becomes `ready` with `availability: unavailable` and an info message; it is never reported as invalid. Verified in a real browser with a 1.5 GB MKV-header file.
- Large files: only 64 bytes are read; metadata comes from a streamed object URL that is revoked on every path. Future strategy (documented in the architecture doc): chunked/streamed upload with `File.slice`, server writes incrementally to disk, FFmpeg reads from disk.

## 9. UI
Only `UploadDropzone` changed (plus a new `errorCopy` module). States: default, hover (surface lift), drag-over (accent tint), validating, accepted, processing ("Preparing your media..."), ready ("Ready for analysis"), error (what/why/fix), disabled. Detail list shows type, size, and duration/resolution when available. Dimensions per spec (680px/280px/32px; mobile full-width/240px/24px). No new colors, spacing values, radii or button styles; design system doc updated for the new states.

## 10. Accessibility
Native button reachable and activatable with Enter/Space (tested); drag-and-drop is optional; `role="group"` labelled by the heading and described by the formats/limit hint; `aria-busy` while working; live region announces checking/preparing/ready/failure; errors use `role="alert"`; hidden file input has an accessible name; disabled state uses the real `disabled` attribute plus `aria-disabled`; reduced motion handled globally. Not done: screen-reader testing on real devices.

## 11. Security
Implemented: layered validation (above); content signature check; sanitised names with tests for traversal, shell metacharacters, bidi/zero-width/control characters, fullwidth separators; `Object.hasOwn` check so `a.constructor`/`a.__proto__` are not "extensions"; object URLs revoked in success, error and timeout paths (tested); errors are typed and user copy contains no paths or stack traces (tested); no file content is read beyond 64 bytes in the app; no storage, no network.
Honest limits: this is **client-side only and not a security boundary**. A matching header does not prove a file is benign (polyglots, malformed streams); the browser decoder parses untrusted media when reading metadata. The server stage (Checkpoint 2) must re-validate everything, run FFmpeg with a locked-down argument allowlist, limits and an unprivileged user, and treat subtitle text as untrusted. Mixed-script homoglyph filenames are not detected (display-only, accepted risk).

## 12. Performance (baseline, this machine, Chromium in the app's browser pane)
| Measure | Result |
| --- | --- |
| JS bundle | 282.47 kB (89.56 kB gzip) — was 276.75 kB (87.71 kB) before: +5.7 kB |
| CSS bundle | 17.93 kB (4.49 kB gzip) |
| Build time | ~80 ms (vite), tsc included in `npm run build` |
| Real 136 KB WebM (generated in-browser), drop → ready | ~17 ms total (validating ~6 ms, metadata ~6 ms) |
| Invalid file (HTML renamed .mp4), drop → failed | ~5 ms |
| 1.5 GB synthetic MKV, drop → ready | ~211 ms, almost all spent in reading the 64-byte head of a composite Blob; metadata failed fast |
| JS heap around the 1.5 GB file | 83 MB before, 83 MB after (`performance.memory`, coarse) |
Not measured: low-end devices, Safari/Firefox, real long MKV/AVI/HEVC files, per-frame costs (nothing extracts frames yet).

## 13. Tests
`npm test`: **10 files, 96 tests, 96 passed, 0 failed, 0 skipped** (~0.8 s). New coverage: validation (valid, bad extension, bad MIME, oversized, empty, suspicious/empty filenames, prototype keys), container sniffing, malformed metadata (NaN, Infinity, negative, strings, absurd values), every state transition plus illegal ones, ingestion service with fake processors (no browser/FFmpeg needed), browser processor with a fake `<video>` (cleanup, timeout, error), and UI (default, keyboard Enter/Space, drag-over, processing → ready, unavailable-metadata, four error types with what/why/fix, no leakage, recovery, disabled, busy). Mobile layout is **not** unit-tested (jsdom does not apply CSS); it was verified in a real browser instead.
`npm run lint`: clean. `npm run typecheck`: clean.

## 14. Build
`npm run build` succeeded: `index.html` 1.01 kB, CSS 17.93 kB, JS 282.47 kB. `dist/` is git-ignored.

## 15. Visual verification (actually performed, real browser, dev server)
Widths 320, 375, 768, 1024, 1280, 1440: `scrollWidth` equals `innerWidth` at all six (no horizontal overflow); nav toggle shows below 768 and hides at 768+; hero is one column at 768 and two columns at 1024+. Upload zone measured 680 px wide at 1440 and 288 px (full content width) at 320. Screenshots reviewed: ready state (desktop), error state (320 px), default state (1440). Real WebM dropped end to end (ready, 0:02, 640×360). Not visually inspected: every state at every width, drag-over appearance in a real drag, disabled appearance (tested by attribute only), 1024/1280 screenshots.

## 16. Known Limitations
- Still no backend, FFmpeg, upload or storage; "Ready for analysis" means a valid, described asset exists locally, not that analysis is possible (the UI says so).
- `accepted` is transient: accept and process happen back to back, so users rarely see it.
- Browser metadata gives only duration/dimensions; MKV/AVI/HEVC often unreadable (reported as unavailable).
- MediaRecorder-style files with unknown duration are reported as malformed/unavailable.
- Allowlisted MIME types may exclude unusual browser-reported values (would show "unsupported").
- Only the first dropped file is used; no cancel button during processing.
- Safari/Firefox untested. Bundle includes ~6 kB of new code; no code splitting yet.
- `timeout`/`storage-failure` codes are defined but unused until the server exists.

## 17. Future Work (Checkpoint 2 should build)
Node/TypeScript API; install FFmpeg/FFprobe; `FfprobeMediaProcessor` (codec, frame rate, audio/subtitle presence); streamed upload and disk storage with temp-file lifecycle; audio and subtitle extraction; then speech-to-text and subtitle parsing. Re-validate everything server-side.

## 18. Git
See the final message for commit hash and push verification (a commit cannot contain its own hash). Commit message: `feat: establish SafeWatch media ingestion foundation`; remote `origin` (Safe-Watch); pushed normally to `main`.
