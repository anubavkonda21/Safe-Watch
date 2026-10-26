# CHECKPOINT 9 REPORT: Complete Product Experience

**Only flagged terms in speech and subtitles are detected. Sexual content, violence, graphic injury and drug-related content remain unsupported. No score, no verdict: a result without findings does not mean a video is safe. No new detection model, no external service, no server endpoint was added.**

Baseline: `95c795a9150789cb53ffd86162df7aa8f94826f1` (`feat: playback safety actions`, `main`), verified before starting: clean tree, CP8 ancestor, local equals `origin/main` (`git ls-remote`), existing checks green.

## 1. What was built

- **Warning** (`src/domain/warnings`, `src/features/playback/UpcomingWarning.tsx`, `usePlaybackCoordinator`): pure scheduler with injected clock and surface; groups of overlapping findings; Skip/Ignore reuse the CP8 override path exactly once; expiry and dismissal never act. One hook, one set of listeners, one boundary timer feeds both coordinator and scheduler (no second playback engine).
- **Custom phrases** (`CustomFilters`, `updateCustomFilter`, `appliedStore`): add, edit in place, remove, enable; validation and duplicate rules; saved / active / not-applied status; accurate privacy copy (enabled phrases go to your own SafeWatch server when you analyze; not stored or logged; never "learned").
- **Preferences** (`src/domain/preferences`, `PlaybackPreferences`): warnings on/off, lead 10/20/30 s (default 20), visible 3/5/8 s (default 3), default action none/mute/skip reusing CP8; validated `localStorage` with in-memory fallback. No "censor everything" mode.
- **Feedback** (`src/domain/feedback`, `FeedbackPanel`): missed-finding report with timestamp prefilled from the playhead, phrase, category (heard / subtitle / unsure), optional note; confirm/cancel; local only; review, delete one or all; states it does not train anything or guarantee a change.
- **Honest status** (`ProductGuide`, `EvidenceAvailability`, playback disclaimer, "Why can a finding be unavailable?"): supported media, evidence availability, only flagged terms, absence is not safety.
- **Polish:** consistent wording, focus handling, reduced motion, 44 px targets, warning slot reserved under the player (no layout shift), a real 320 px overflow found and fixed (see section 5).

## 2. Warning timing and playback safety

Measured on a real H.264/AAC file in the in-app browser (a timer schedules the show at the real boundary; rendering timing is separate and was observed, not assumed). The warning appeared at the 20 s lead (within the sampling resolution), stayed 3 s, and expiry left playback untouched. Skip from the warning jumped to the interval end once; Ignore suppressed the finding and its action; hover held the countdown (real mouse hover; a synthetic `mouseenter` does not reach React, so the first attempt was invalid and re-done); seek, replay and replacement behaved as in the scheduler tests; replacing the video removed the card and player, revoked the old object URL and reset choices, and the new file warned for its own finding. Page hidden: state is re-evaluated on return.

## 3. Custom phrases and preferences

Edit keeps position, rejects empty, duplicate and over-length phrases, and `not-found` for a stale id; the analysis only changes on re-run, and the page says so ("not applied"). Preferences parse own properties only (hostile prototype keys ignored), clamp to the allowed options and fall back to defaults.

## 4. Feedback

Stored only in this browser; no endpoint, no logging, never becomes a finding; at most 200 reports; timestamps `m:ss`, `h:mm:ss` or seconds; the confirm step shows exactly what is stored.

## 5. Validation (exact commands, all exit 0)

| Command | Result |
| --- | --- |
| `npm run lint` | exit 0, no warnings |
| `npm run typecheck` | exit 0 |
| `npm test` (run three times) | exit 0 each; 77 files, **1300 tests passed, 0 skipped** (CP8: 1,078; +222) |
| `npm run build` | exit 0 (client 396.71 kB, 120.85 kB gzip) |
| `npm run build:server` | exit 0 |
| `npm run eval:safety` | exit 0; 43 examples, 37 passed, 6 known limitations, 0 failed (unchanged) |
| `npm run check:playback` | exit 0; 27 to 56 ns per event, setup 0.02 to 12 ms (unchanged class) |

Test coverage added: 38 scheduler tests (lead boundary, late seek, queue and gap, no duplicates, seek, pause, replay, end, disable, dispose, late timers), grouping, preferences, local store, report validation, phrase editing, 34 warning UI tests, preferences UI, feedback UI (19), product guide, evidence availability, 4 end-to-end journey tests, and a 6-test layout guard. Unsupported categories stay unsupported (asserted). One non-reproducing dropzone timeout appeared once under parallel load earlier; three later full runs passed.

## 6. Real-media and responsive QA

Real pipeline on a real file; 0 console errors; the app made no third-party requests to any analysis or media service, but this report originally overstated it: **`index.html` also loads the Inter font stylesheet from `fonts.googleapis.com` (present since Checkpoint 0A), so every page load contacts Google.** Corrected in Checkpoint 10 (finding F11) and removed by self-hosting the font in the follow-up; media, transcripts and phrases are not sent there. Horizontal overflow checked at 320, 375, 768, 1024, 1280 and 1440 px. **Defect found only in the browser:** at 320 px the layout viewport grew to 331 px because grid items could not shrink; fixed with `minmax(0, 1fr)` and wrapping buttons, with a regression guard test. Screenshots: `docs/screenshots/checkpoint-9-1-warning-desktop-1440.jpg`, `-2-warning-narrow-449.jpg`, `-3-warning-mobile-320.jpg`, `-4-report-form-narrow-449.jpg`. Separate screenshots at 375, 768, 1024 and 1280 were not taken (overflow scans only). Only Chromium in the app pane was used.

**Incident:** the API preview server died once during QA (the `tsx watch` process was killed) and was restarted; no data or code impact.

## 7. Security and privacy

No endpoint added or changed; nothing new is sent to the server except the enabled phrases that CP4 already sent for analysis; preferences, phrases and reports are local; user phrases and reports are not logged; no absolute paths stored; text is rendered as text. **Not production secure.** Still open for the hardening checkpoint: authentication / media-id access control (ids are bearer tokens), rate limiting, disk quotas, FFmpeg/helper sandboxing, lifecycle cleanup.

## 8. Known limitations

Not sample accurate (CP8 intervals); word-timed speech findings are often zero-length and unavailable; warnings are only as good as the findings; local storage can be cleared or unavailable (then memory only); the file must stay in the page; no audio-waveform verification; only Chromium tested; only flagged terms.

## 9. Explicitly NOT implemented

Any other category, new model, safety score, server-side lists, accounts, sync, telemetry, edited output, beep/blur. No Checkpoint 10 work was started. Roadmap renumbered (new row 9; remaining checkpoints shifted by one).

## 10. Git

One commit `feat: complete SafeWatch product experience`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`, `git status -sb`.
