# CHECKPOINT 10 REPORT: Security Hardening

**Result: partially complete.** The objectives were implemented and tested for one deployment: a single person on one macOS machine, API on loopback. **SafeWatch is not generally production-ready**: there is no sandbox on Linux or Windows, no TLS, no real user accounts, no encryption at rest, no CSP, no shared rate limiting, (the Google Fonts request found during the audit was removed in a follow-up, see section 5). Parent commit `a8a36740050897d93e95506af6dfcc58ec5c5a69`. Design and findings: `SAFEWATCH_MEDIA_ARCHITECTURE.md` §32.

Legend: **[T]** implemented and tested · **[P]** implemented, incompletely tested · **[N]** not implemented · **[G]** release gate / deployment dependent.

## 1. Controls

| Area | Control | State |
| --- | --- | --- |
| Access | Anonymous per-browser session (256-bit random, HttpOnly, SameSite=Strict, Path=/api; only a SHA-256 digest stored); every media route checks ownership; other sessions and unknown ids get the same 404; no session gets 401; foreign delete is a no-op | [T] |
| Access | `Secure` cookie attribute on request | [T] attribute only; real HTTPS deployment [P] |
| Browser | Host allow-list (DNS rebinding), Origin and `Sec-Fetch-Site` checks on every method, CORS with credentials for exact origins only | [T] |
| Limits | Per-minute limits (upload 10, analysis 60, read 3000, other 300), bounded LRU state, `429` + `Retry-After` | [T] |
| Limits | Rate limiting behind a proxy / several processes | [N] |
| Quota | Reserve-before-write total (10 GB) / session (4 GB) / count (5) budgets, free-disk floor (512 MB), declared length enforced as the stream limit, derived files charged and settled, release on delete/expiry/failure/cancel, stale accounting finished by the sweep | [T] |
| Quota | Whisper temporary JSON (OS temp dir, ≤3600 s audio, removed in `finally`) not counted | [N] gap |
| Files | UUID-only names, exclusive create, 0600/0700, marker directory, `lstat` + `O_NOFOLLOW` reads, link-safe purge, partial-upload cleanup | [T] |
| Processes | argv only, minimal env, neutral cwd, absolute paths, file-only FFmpeg protocols, process groups, SIGTERM→SIGKILL, settle after exit, registry stopped at shutdown | [T] |
| Sandbox | macOS Seatbelt: no network, no fork, writes only to the tool's directory (+ Metal shader cache for whisper) | [T] on macOS; reads unrestricted; deprecated API |
| Sandbox | Linux, Windows; CPU/memory limits | [N] [G] |
| Lifecycle | Legal-state machine, duplicate jobs are no-ops, shutdown cancels jobs/stops tools/purges/exits 0, restart on same directory, session end deletes that session's media | [T] |
| Validation | Strict body and query schemas, prototype keys rejected, fixed error messages, no phrases/filenames/cookies in logs | [T] |
| Config | Loopback default; network bind needs opt-in + host list; production needs storage dir + sandbox; one-line startup errors | [T] |
| Dependencies | `npm audit`: 0 (vite 8.3.2→8.3.5, zod 4.6.5→4.6.7, undici 8.11.2→8.12.3, plus patch bumps of rolldown/postcss; lockfile only, no `package.json` change) | [T] |
| Other | TLS, accounts, logout, encryption at rest, CSP/security headers, independent review, parser fuzzing | [N] [G] |

## 2. Validation (final working tree, run sequentially, nothing else running)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run lint` | 0 | clean |
| `npm run typecheck` | 0 | clean |
| `npm test` (3 runs, then again after the last lockfile update) | 0 | 83 files, **1513 tests passed, 0 failed**, no skipped tests (CP9: 1300; +213, of which 10 in `securityAudit.test.ts` spawn the real server) |
| `npm run build` / `npm run build:server` | 0 / 0 | built |
| `npm run eval:safety` | 0 | 43 examples, 37 passed, 6 known limitations, 0 failed (unchanged) |
| `npm run check:playback` | 0 | 27–56 ns/event class (unchanged) |
| `npm audit` | 0 | 0 vulnerabilities (earlier: 1 high in vite; 2 high in dev-only zod and undici published later) |

New suites: `securityAccess` (38), `securityLimits` (30), `securityFilesystem` (52), `securityProcess` (28, real Seatbelt, real FFmpeg/whisper parsing, process-tree kill), `securityLifecycle` (46), `securityAudit` (10), plus config tests. Existing tests changed only where behaviour deliberately changed: sessions required, strict queries (`?evidence=` is now 400), credentials CORS header, one wait made deterministic.

### The earlier flaky run
Not a CP10 race. Reproduced deliberately: two suites at once passed; with **four** suites at once the same 4–5 timing-dependent tests fail every time: two CP4 queue-full tests (they rely on a 500 ms wall-clock job timeout), two CPU-heavy web tests that hit vitest's 5 s default (`safety.test.ts` truncated list, `journey.test.tsx`), and one of my own lifecycle tests (it waited a fixed 15 s; now waits for the job itself). Sequentially they pass 6/6 runs. The pre-existing four were **not** modified; they are load-sensitive and should not be run concurrently with other suites.

## 3. Real-server evidence (actual `server/src/main.ts`, whisper.cpp + Apple Vision enabled, sandbox on)

- Listens on `127.0.0.1` only (`lsof`); log shows `sandbox: seatbelt`.
- Real file: upload → transcript "hello, this is a safe watch test…", 1 visual frame, context, 1 finding, frame 200 `image/jpeg`.
- Second browser on the first's id: 404 on every route (same as an unknown id), POST/DELETE no effect; no cookie 401; forged cookie 401; `Host: evil.example` 403; foreign `Origin`, cross-site fetch, evil preflight 403; traversal ids 404; error bodies contain no paths.
- 6 anonymous uploads at 5/min: 3 accepted, then `429` with `Retry-After`, nothing written.
- Declared-oversize, chunked-oversize, truncated and client-aborted uploads: 413 / 000 / no file left in the store.
- Quota 1 MB/2 MB: 2 uploads accepted, third `507 QUOTA_EXCEEDED`, delete one, next accepted.
- MP4-header garbage: ends `failed invalid-media`, file deleted.
- `SIGTERM` during whisper + Vision: 2 child processes stopped, no orphans, store empty, exit within 4 s.
- Production-mode start with a storage dir works; `SAFEWATCH_HOST=0.0.0.0` exits 1 with one clear line.
- Browser (Vite proxy): upload, analysis, frames, findings and playback panel work; 0 console errors; cookie not readable from JS.
- Cost: sandbox +5 ms per tool start (ffprobe 20.1→25.3 ms); limiter 63 ns, session lookup 463 ns (SHA-256), quota 103 ns per op. A sandbox mistake found and fixed on the way: whisper under the first profile took 14.5 s per transcription (Metal shader cache write denied); now 0.3 s.

## 4. Audit answers
- **Can session eviction invalidate legitimate users? Yes, idle ones** (tested): more than `maxSessions` newer sessions push an idle session out → 401. Mitigated, not eliminated: LRU keeps active sessions (tested), session creation is limited per address (tested), and an ended session's media is deleted rather than orphaned (tested).
- **Is shutdown cleanup safe in every lifecycle state?** Tested with the real process: during extraction, during an upload, idle, double signal, restart on the same directory, and refusal to start on a directory it does not own (its files untouched). **Not safe against SIGKILL/crash**: tools may outlive the server until they finish; the next start purges the directory.
- **Whisper temp JSON / crash recovery:** outside the quota; swept at startup if older than an hour.

## 5. Privacy discrepancy (resolved in a follow-up)
`index.html` loaded Inter from `fonts.googleapis.com` (since CP0A), so every page load disclosed the visitor's IP and user agent to Google (no media, transcript or phrase). CP9's "no third-party requests" was wrong and was corrected. Follow-up: Inter v4.1 `InterVariable.woff2` from the official release (rsms/inter, zip SHA-256 `9883fdd4…b11e`) is served from `public/fonts/` with its OFL licence; the three `<link>` tags are gone. Verified in a browser on a fresh load: the only origin is `localhost:5173`, one font request, same layout metrics as before.

## 6. Known limitations
Single-user/macOS/loopback only; sandbox reads and resources unrestricted; deprecated `sandbox-exec`; sessions are browser-profile scoped and lost on restart; clearing cookies strands your media until it expires; unencrypted storage; shared-address rate limit pooling; whisper temp JSON uncounted; Windows/Linux and HTTPS unverified; no independent review.

## 7. Git
One commit `security: harden SafeWatch for production`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main` and `git ls-remote origin refs/heads/main`.
