# CHECKPOINT 11 REPORT: YouTube Player Integration

**What was delivered: YouTube playback inside SafeWatch plus phrase checking against a caption file the USER supplies. This is NOT full YouTube video analysis.** SafeWatch cannot hear or see an embedded YouTube video and cannot get YouTube's captions for a video it does not own; no permitted path for any of that exists (section 2). Speech recognition and scene detection are unavailable for YouTube sources, and the interface says so. Parent commit `51221a3053c1191786f9b57ce4af27c5e9d60b90`.

Legend: **[T]** implemented and automatically tested · **[V]** verified in a real browser against real YouTube · **[N]** not implemented / not possible · **[G]** needs a decision.

## 1. What was built

- **Source selector** (tabs: Local file / YouTube). Only the chosen source is mounted; switching destroys the other's player and state. The local-file experience is unchanged. [T][V]
- **Strict URL parsing** (`src/domain/youtube/url.ts`): watch, `youtu.be` and Shorts links only; the 11-character id is the only thing kept; other hosts, embed/iframe/script URLs, credentials, ports, look-alike and Unicode hosts, `javascript:`/`data:`/`file:`, encoded or ambiguous ids, control characters and overlong input are rejected with a plain message that never echoes the input. [T][V]
- **Official IFrame Player API** (`iframeApi.ts`, `YouTubePlayer.tsx`): script injected once, only when a valid link is first loaded; privacy-enhanced host `youtube-nocookie.com`; `autoplay: 0`; the page origin is passed; YouTube's controls, branding and ads untouched; nothing drawn over the player; frame titled; destroyed with its timers and listeners when the video changes or the component goes away; ready-timeout. [T][V]
- **Playback driver seam** (`PlaybackDriver`, `PlaybackShell`): the CP8 coordinator and CP9 warning scheduler now run against a driver, with a `<video>` driver (behaviour unchanged, all existing tests pass) and a `YouTubeDriver`. No second analysis or playback engine. [T]
- **Caption analysis** (`captions.ts`, `analysis.ts`): SRT/WebVTT read in the browser (≤2 MB, ≤20 000 cues), then the existing context builder and flagged-term classifier. Always **partial**; provenance names the user's file. [T][V]
- **Honest state model** (`sourceState.ts`): source validated, player loading/ready/error(kind), analysis unavailable/pending/in-progress/partial/complete/failed, and a per-capability list with source, method and limits. `complete` is unreachable today by construction. [T]
- **Late and missed findings** (`discovery.ts`): each finding is stamped with the playhead when first found; "late" and "missed" are reported and banners/warning notes say so. [T][V]

## 2. Feasibility matrix (details: `SAFEWATCH_MEDIA_ARCHITECTURE.md` §33.1)

| Capability | Result |
| --- | --- |
| Embedded playback, position, state, rate, seek, mute | Available through the documented IFrame API |
| Caption text of arbitrary videos | **Not available**: the player API returns none; `captions.download` needs the owner's OAuth permission |
| Audio, frames | **Not available** and not obtainable without prohibited download/separation/scraping |
| Speech recognition, scene categories for YouTube | **Not possible through permitted means** |
| Automatic mute/skip via `mute()`/`seekTo()` | Supported by the API; the developer policy has no explicit rule; default is "no action", user opt-in only; **[G] confirm before distributing** |
| User-supplied captions | Permitted, implemented |

## 3. Validation (final tree, run sequentially)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run lint` | 0 | clean |
| `npm run typecheck` | 0 | clean |
| `npm test` (twice) | 0 | 93 files, **1748 tests passed, 0 failed, 0 skipped** (CP10: 1513; +235) |
| `npm run build` / `npm run build:server` | 0 / 0 | built |
| `npm run eval:safety` | 0 | unchanged (43 examples, 37 passed, 6 known limitations, 0 failed) |
| `npm run check:playback` | 0 | passes |
| `npm audit` | 0 | 0 vulnerabilities; no dependency was added or changed |

New tests: URL parsing 69, captions 14, analysis 8, discovery 11, state machine 12, API loader 10, driver 42 (including 9 integration tests of the real coordinator and scheduler on a fake YouTube player), player component 20, panel 39, selector and layout rules 10. All use a fake player: the suite never contacts YouTube. Covered: malicious/malformed URLs, init/teardown/duplicate init (incl. StrictMode and a fast switch before the API loads), load failures and every documented error code, switching and stale-state cleanup, state synchronisation/seek/buffering/rate, late/missed/valid findings, warning scheduling and cancellation, unsupported capabilities, no network use, local-file regression, tab keyboard behaviour and layout rules (stylesheet text).

## 4. Real-browser verification [V]

Chromium in the desktop app, real YouTube, public video "Big Buck Bunny" (id `aqz-KE-bpKQ`, Blender Foundation); captions were synthetic cues I wrote.
- Nothing from YouTube is requested until Load video is pressed; invalid links produce messages and no request; the embed is `youtube-nocookie.com/embed/<id>` with `autoplay=0`.
- Warnings appeared during real playback at about 20 s ahead and stayed about 3 s; Ignore left playback untouched.
- Skip jumped 0:09→0:12 through `seekTo`; mute: the real player's `isMuted()` flipped true at 71.05 s for a 71.00 s cue and false at 76.02 s for a 76.00 s cue (50 ms sampling).
- A late finding produced the late banner; a nonexistent id produced the "cannot be played here" message (YouTube answers 150/101 for a missing video, so the copy lists every possible cause); a new link cleared the old captions and findings.
- 320 px: no horizontal overflow, player 286×200 (a defect found here: it was 198 px high because of the border; fixed to meet YouTube's 200 px minimum).
- Switching to Local file removed the player; a local upload then produced the same speech finding through whisper.cpp as before.
- **Not verified live:** advertisements, owner-disabled embedding, private/age-restricted/region-blocked videos, Shorts playback, live streams, other browsers.

## 5. Privacy and policy
Contacted only after a valid link: `www.youtube.com` (API and widget scripts) and `www.youtube-nocookie.com` (player); YouTube receives normal player information under its terms. Phrases, caption file and findings go nowhere (no `fetch`, no SafeWatch server call: tested). Nothing from YouTube is downloaded, cached, separated or stored, and no YouTube screenshots were added to the repository. The SPA still has no CSP (F12); the allow-list a CSP would need is in §33.5. Security controls from CP10 are untouched.

## 6. Remaining bugs, gates and decisions
- **[G]** Automatic mute/skip on YouTube: API-supported, policy silent. Confirm for the intended use.
- **[G]** Advertisements may be reported by the API as video playback (ad position/duration): untested; could mis-time warnings.
- **[G]** Owner-authorised captions (OAuth) would only help for the user's own videos.
- Caption files cannot be verified against the video; no offset correction.
- Small controls inherited from the playback panel (selects 28 px, checkboxes 20 px) are below 44 px at 320 px (pre-existing, B4).
- Landing-page copy still says "Nothing is uploaded" and promises scenes/masking (PRODUCT_ACCEPTANCE_REPORT B1/B2): not changed here.
- A few lines of the playback panel copy mention "your file"/"subtitles" generically; the YouTube footnote states the YouTube specifics.

## 7. Git
One commit `feat: add YouTube player integration`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`.
