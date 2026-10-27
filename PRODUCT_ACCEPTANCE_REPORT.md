# SafeWatch: Product Acceptance Audit (Phase 1, updated after Checkpoint 11)

> **Update, Checkpoint 11 (YouTube).** Requirement 2 changed from Missing to *Partially implemented*, and requirements 1, 3, 4, 6-9 gained a YouTube variant, all described in the rows below and in `CHECKPOINT_11_REPORT.md`. Everything else in this audit is as of `51221a3`. YouTube speech and scene analysis are **blocked by YouTube's API and policies**, not merely unbuilt.

The original audit (sections 1-7) was audit-only. Repository at audit time: `main` = `origin/main` = `51221a3` (`docs: fix README sentence`), working tree clean, CP10 (`0760d25`) and Inter self-hosting (`4ff03e2`) present.

**Verdict.** The *local-file* product works end to end for ONE detection type (the user's own words and phrases, in speech and subtitles), with a timed warning, Skip/Ignore, mute/skip playback and local feedback notes. Most of the original vision is **not** present: YouTube only plays (and checks a caption file the user supplies; the stream cannot be analysed), no scene detection (sexual/violence/graphic injury/drugs), no warning category beyond "flagged phrase", no "skip 10 s" button, no learning from reports, no beep/blur/subtitle censoring. The landing page still contains copy from CP0A that is now false.

Legend: **IV** implemented and verified · **P** partially implemented · **INV** implemented but not verified · **M** missing · **B** broken (wrong/misleading) · **BL** blocked by a technical/platform limit.

## 1. Facts: how it was checked

Commands run on the final tree (sequentially): `npm run lint` 0 · `npm run typecheck` 0 · `npm test` 0 (83 files, 1513 passed, 0 skipped) · `npm run build` 0 · `npm run build:server` 0 · `npm run eval:safety` 0 (43 examples, 37 passed, 6 known limitations, 0 failed). Real app run: API (whisper.cpp + Apple Vision + macOS sandbox) and Vite dev server in the in-app browser, with a synthetic 40 s H.264/AAC clip I generated (TV test pattern; speech from `server/test/fixtures/speech-en-in.mp4` placed at ~25 s). No private media, no third-party service contacted: the only origin on page load is `localhost:5173` (Inter is self-hosted); `fonts.googleapis.com` no longer appears.

Observed in that run (facts): phrase "safe watch test" added in the UI → status "Saved and active"; upload → finding `0:26.45 to 0:27.83`, category "Flagged terms", "Word timing, approximate"; playing from 5.5 s: warning appeared at playhead 6.46 s = **19.99 s before** the finding, text "A flagged phrase is coming up. “safe watch test” Starts in about 20 seconds.", visible **2.98 s**, then removed; clicking **Ignore** left playback running (advanced 1.51 s, not paused) and set the finding to "ignore"; clicking **Skip** on a warning and playing on: playhead continued past the finding to 27.83 (the end of the finding interval). Console errors: 0. At 320 px: no horizontal overflow; some interactive elements measure 16–18 px tall (not identified).

## 2. Requirement matrix

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Website with a video player | **P** | The player is a native `<video controls>` for the **user's own uploaded file**, rendered after analysis (`src/features/playback/PlaybackPanel.tsx:105`, object URL from `useMediaIngestion`). Verified in browser (duration 40, plays). It is not a general player: only files. |
| 2 | YouTube integration / playback workflow | **P** (playback and user-supplied captions: **IV**; speech/scene analysis of the YouTube stream: **BL**) | Since Checkpoint 11: a YouTube tab with strict URL parsing (`src/domain/youtube/url.ts`, 69 tests), the official IFrame player (`src/features/youtube/YouTubePlayer.tsx`, `src/infrastructure/youtube/*`), phrase checking against a caption file the user supplies (`src/domain/youtube/analysis.ts`), warnings/skip/mute through the existing engine via `PlaybackDriver`; verified against real YouTube (`CHECKPOINT_11_REPORT.md` §4). **Blocked:** the player gives the page no audio, picture or caption text; `captions.download` needs the owner's OAuth permission; downloading/separating audio or scraping is prohibited (`SAFEWATCH_MEDIA_ARCHITECTURE.md` §33.1). So "analysis before the user reaches detected content" holds for YouTube only when the user adds a caption file before playback. |
| 3 | Analysis before the user reaches detected content | **IV** (for uploaded files) | Pipeline completes before findings are shown: `server/src/application/{mediaService,extractionService,textAnalysisService,visualAnalysisService}.ts`; real run above; `server/test/e2e.test.ts`, `securityAudit.test.ts`. Requires local setup: speech is off by default (`SAFEWATCH_SPEECH_PROVIDER=none`, `.env.example`) and needs whisper.cpp + a model; without it only subtitles are read. |
| 4 | Advance warning ≈20 s before a supported finding | **IV** | Measured 19.99 s (§1). `src/domain/warnings/scheduler.ts`, 38 tests in `scheduler.test.ts`, 34 in `src/features/playback/PlaybackWarnings.test.tsx`. Only for findings with usable timing; zero-length word timings are "unavailable" and never warn (`src/domain/playback/planning.ts`; documented CP8 limitation). |
| 5 | Warning identifies the content category | **P** | The only category is "flagged phrase": `UpcomingWarning.tsx` title/`warningPhrases`. It shows the user's phrase, not a category such as violence. The category exists on the finding (`categoryById(...).label`, `PlaybackPanel.tsx:178`) but not in the warning. Other categories do not exist (#12). |
| 6 | Visible ≈3 s | **IV** | Measured 2.98 s; default `durationSeconds: 3` (`src/domain/preferences/preferences.ts`); configurable 3/5/8 s; holds while hovered/focused. |
| 7 | Dismiss or "slide away" | **P** | A dismiss (X) button and Escape (`UpcomingWarning.tsx`; tests in `PlaybackWarnings.test.tsx`). No swipe/slide gesture: no touch/pointer-swipe code exists. Reduced-motion respected (`upload.css`). |
| 8 | Button to skip forward 10 seconds | **M** | No such control (`grep` for 10 s skip → none). "Skip" in this product means *jump to the end of the finding* (CP8 coordinator), armed from the warning or the finding list; the player has only the browser's native controls. This differs from the original wording. |
| 9 | Ignore a warning without changing playback | **IV** | Measured: playback continued after Ignore; the finding is set to "ignore" (undoable in the list). Expiry and dismiss do nothing (`scheduler.test.ts` "expiry only ever hides"). Note: Ignore also suppresses that finding's later automatic action (by design, CP9). |
| 10 | User words/phrases via speech recognition and subtitles | **IV** (local setup) | `src/domain/text/customFilter.ts`, `src/domain/safety/flaggedTerms.ts`, speech via whisper.cpp (`server/src/infrastructure/speech/whisperCppProvider.ts`), subtitles via FFmpeg. Real run found the phrase in speech. Limits (eval fixtures `npm run eval:safety`): misses spaced letters, substitutions, inflections, split cues, misheard words; ambiguous same-spelling matches (6 known-limitation cases). |
| 11 | Censorship behaviour for those phrases | **P** | Mute (the player's `muted` flag) and skip only (`src/domain/playback/coordinator.ts`); media is never edited. No beep, blur, subtitle masking, or rendered output; muting is not sample-accurate (word timing ~0.1 s, 150/250 ms margins). The landing copy promises "mask" (see B1). |
| 12 | Scene detection: sexual, violence, graphic injury, drugs | **M / BL** | `src/domain/safety/taxonomy.ts`: all four `support: 'unsupported'`; the UI says so (`ProductGuide.tsx`, `EvidenceAvailability.tsx`). Apple Vision labels/OCR are evidence only (CP5), never findings. Blocked: no feasible local classifier was identified in CP7 (`SAFEWATCH_MEDIA_ARCHITECTURE.md` §29.2); needs a model decision and an evaluation set. |
| 13 | Missed-scene reporting with timestamp and category | **P** | `src/features/feedback/FeedbackPanel.tsx`, `src/domain/feedback/report.ts` (timestamp prefilled, phrase, category `heard|subtitle|unsure`, note; 19 + domain tests). It reports missed *phrases*, not scenes; no scene categories exist. |
| 14 | Genuine feedback learning | **M** (by design) | Reports are `localStorage` notes (`src/features/feedback/feedbackStore.ts`); no code reads them to change detection; UI states "does not train SafeWatch" (`FeedbackPanel.tsx:66`). No server endpoint, no model, no evaluation loop. |
| 15 | Privacy: where data goes | **P / B** | Verified by code, tests and run: media is uploaded to the local SafeWatch server (loopback, sandboxed tools, deleted ≤60 min, quota); enabled phrases are sent to that server per analysis, not logged (`server/test/securityLifecycle.test.ts`); transcripts live in server memory until expiry; preferences, phrases, reports are browser `localStorage` only; no third-party requests after the font change. Accurate in the app panels, **but the landing page contradicts it (B1)**. Unencrypted at rest; no TLS (CP10 gates). |
| 16 | Responsive + accessibility | **P / INV** | Overflow checked at 320–1440 px (CP9 QA; re-checked at 320 here: 0). `layoutGuard.test.ts`, jsx-a11y lint clean, live regions, focus handling, reduced motion, `lang=en`. **Not verified:** screen-reader behaviour, automated axe audit, contrast measurement, touch-target sizes (16–18 px elements seen at 320 px). |
| 17 | Security/operations (CP10) | **IV** for single-user macOS loopback; **BL/M** beyond | `CHECKPOINT_10_REPORT.md`, `SAFEWATCH_MEDIA_ARCHITECTURE.md` §32, 204 `server/test/security*.test.ts`/config tests. Open gates: sandbox on Linux/Windows, TLS, accounts, encryption at rest, CSP, shared rate limiting, CPU/memory limits. Not "production-ready". |

## 3. Known bugs and misleading text (verified in source)

- **B1 (high, trust):** `src/components/marketing/InfoSections.tsx:13` says "videos you select are checked and read locally in your browser. **Nothing is uploaded.**" The app uploads the file to the local server (and says so at `UploadDropzone.tsx:244`). The same section says "the analysis engine is not built yet" (`:27`).
- **B2 (medium):** `HowItWorks.tsx:5-9` marks Analyze/Review/Watch "planned" and "only the first step has a preview"; `FeaturePreview.tsx` says "Planned capabilities", "Reads speech, subtitles and **scenes** together", "places [moments] on a timeline before you press play", "Mute, **mask** or skip". Scenes, masking and a timeline of safety moments do not exist.
- **B3 (low):** `UploadDropzone.tsx:41` doc comment says "Nothing is uploaded and no analysis runs" (stale comment).
- **B4 (low, unconfirmed cause):** at 320 px some interactive elements are 16–18 px high.
- **Test sensitivity (known, not a product bug):** four older timing-dependent tests fail only when 4 full suites run concurrently (`CHECKPOINT_10_REPORT.md` §2).
- **Limitations that surprise users:** word-timed speech findings are often zero-length and therefore get no warning or action; the file must stay in the page (reload loses it); Skip arms an action rather than skipping now; session is a browser cookie (clearing it strands the media).

## 4. Unresolved questions (need a product decision)

1. Is YouTube required, or is "upload your own file" acceptable? What does "YouTube integration" mean to the owner: embedding playback, reading captions only, or analysing the video content?
2. Which scene categories are mandatory for the first release, and is any cloud/external model acceptable (it conflicts with the local-first, no-external-AI rule)?
3. Should "learning" mean per-user phrase suggestions/aliases, a global model fine-tuned from reports, or only a review queue for the owner?
4. Should Skip mean "jump now to the end of the finding" (current) or "+10 s from the playhead" (original wording), or both?
5. Is a swipe gesture required, or is a dismiss button enough?

## 5. Prioritised gap backlog (recommendations, not facts)

| Pri | Item | Depends on | Notes |
| --- | --- | --- | --- |
| P0 | Fix B1/B2: make landing copy truthful | none | Copy-only; removes a privacy misstatement. |
| P1 | Playback controls: "+10 s" button, optional swipe/slide dismiss, show the category in the warning | none | Small, fully testable in the existing player; settles #5, #7, #8. |
| P1 | Decide YouTube scope | owner decision Q1 | Likely outcome: documented "not supported" or an embed that offers only user-provided captions/phrases; analysis of YouTube pixels/audio is blocked. |
| P2 | Censorship: subtitle masking, beep/audio replacement | P1 | Beep needs audio processing (Web Audio on the file, or server rendering); sample-accuracy limits stay. |
| P2 | Review queue for reports (owner-visible export), alias suggestions from reports | Q3 | Real learning needs labelled data and an evaluation harness first. |
| P3 | Scene categories | Q2, model selection, labelled evaluation set, CP11-style sandbox review | Largest effort; blocked on feasibility (§29.2). |
| P3 | Accessibility audit (axe + screen reader + target sizes) | none | Needed before any accessibility claim. |
| P3 | CP10 gates for any non-macOS/multi-user deployment | deployment decision | Sandbox, TLS, accounts, CSP, shared rate limiting. |

## 6. Recommended next checkpoint (narrow, testable)

**"Truthful UI and playback controls".** Scope: (a) rewrite the landing copy (B1, B2, B3) to match reality; (b) add a **+10 s** button to the playback panel; (c) show the finding's category label in the warning; (d) add a swipe-to-dismiss for touch with the existing button as the accessible path. No server, detection or dependency changes.

Acceptance criteria:
1. No string on the page says media is not uploaded, that the engine is not built, or promises scenes, masking or a timeline; a test scans the rendered landing page for those claims and asserts the privacy statement matches the panels.
2. The +10 s button seeks `min(current + 10 s, duration)`, is keyboard operable with an accessible name, never moves backward, is disabled without media, and cannot trap or double-seek with an active skip span (unit + component tests with the fake video, and one real-browser check).
3. The warning text names the category ("Flagged terms") for every shown finding; no unsupported category can appear (test).
4. Swipe/slide dismiss on touch dismisses exactly like the X button (no action on expiry/dismiss), is not the only way, and respects reduced motion (pointer-event tests + a 320 px browser check).
5. Existing suites unchanged and green: lint, typecheck, tests, builds, `eval:safety`, no layout overflow at 320–1440 px.

Proposed later checkpoints (each needs its own scope sign-off): **YouTube decision/implementation** (acceptance: a YouTube URL is either rejected with a clear message or handled by the agreed, documented mechanism; no content is downloaded against the terms of service; a test pins the behaviour); **Censorship v2** (acceptance: subtitle masking and beep verified on real media with measured timing error bound); **Scene detection** (acceptance: a labelled evaluation set, published precision/recall per category, no category marked supported without meeting an agreed threshold, sandbox and privacy review); **Feedback review** (acceptance: owner can export reports, and nothing claims "learning" until a measured evaluation shows a change).

## 7. Assumptions (unverified)

That the original "slide away" meant a swipe gesture; that "skip 10 seconds" meant +10 s; that YouTube meant embedding a public video; that scene categories were mandatory. The original requirements text was not available in the repository and was taken from the brief for this audit.

## 8. Checkpoint 11 addendum (facts, with evidence in `CHECKPOINT_11_REPORT.md`)

- **YouTube works for playback**, not for analysis of the stream. The panel lists, per capability, its source and limits; "Your phrases in captions" is available only with a user file, "speech" is unavailable, "scene categories" are not supported.
- **Warnings (#4-#9) on YouTube** use the same 20 s lead / 3 s duration, Skip/Ignore/dismiss; verified live (warning ~20 s ahead, Skip 0:09→0:12, mute 71.05→76.02 s for 71.00→76.00 s cues). There is still no "+10 s" button and no swipe gesture (#7, #8 unchanged).
- **Late and missed findings** are now reported explicitly for caption files added during playback.
- **Still open from section 3:** B1 (landing page says "Nothing is uploaded"), B2 (stale "planned" copy), B4 (controls under 44 px at 320 px; confirmed 28 px selects and 20 px checkboxes), the four load-sensitive older tests.
- **Next-step questions answered or changed:** Q1 (YouTube scope) is answered for now as "playback + user captions"; owner-authorised captions and ads behaviour remain open (see §6 of the checkpoint report).
