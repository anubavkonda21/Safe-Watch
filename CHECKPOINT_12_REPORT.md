# CHECKPOINT 12 REPORT: Truthful UI, Touch Targets and Accessibility

(Requested as "CP11 — Truthful UI, Playback Controls and Accessibility". The repository's `CHECKPOINT_11_REPORT.md` is the YouTube checkpoint, so this report is numbered 12.) Parent commit `5346cb43659593277fd6b6c02f07e1032c82efdd`. No feature was added; scene detection was not started; Skip semantics were not changed.

**Accessibility compliance is NOT claimed.** Automated scans, a measured touch-target audit and keyboard checks were done; screen readers were not used (section 5).

## 1. Misleading product claims corrected [T]

| Where | Was | Now |
| --- | --- | --- |
| `InfoSections.tsx` | "videos you select are checked and read locally in your browser. Nothing is uploaded"; "the analysis engine is not built yet" | "Privacy and limits": a file is uploaded to your SafeWatch server (by default on this computer), checked with local tools, kept 60 minutes by default and deleted, no outside service; a YouTube link contacts YouTube, which receives normal player information (IP address, browser details); SafeWatch cannot see or hear a YouTube video or read its captions, only a caption file you add is checked, in the browser; words are saved in this browser and sent to the SafeWatch server for files only, never to YouTube; unsupported categories named as not detected; no score; no findings is not "safe" |
| `Hero.tsx`, `index.html` | "AI-powered media safety"; "looks inside a video to understand what is happening" | "Media safety on your terms"; finds the words you list in speech and captions, warns ahead, can mute or skip |
| `FeaturePreview.tsx` | "Planned capabilities"; "reads speech, subtitles and scenes together"; "timeline before you press play"; "Mute, mask or skip" | "What it does today": Find / Warn / Control, and "Not supported: sexual content, violence, graphic injury or drug-related scenes" |
| `HowItWorks.tsx` | steps marked "planned"/"preview"; "safety timeline and pre-playback summary" | four real steps, each marked as working today; the Check step distinguishes files (speech and subtitles) from YouTube (caption file only) |
| `AnalysisVisual.tsx` | "Illustrative preview" with Visual and Context lanes | "Illustration only, not a real result. SafeWatch does not detect scenes today."; accessible name says "Not real results" |
| `Footer.tsx` | "analysis features are not yet available" | "it checks only the words and phrases you list" |
| `UploadDropzone.tsx` | screen-reader status "Analysis has not started" for uploaded media; alert promising "a full safety analysis ... in a later release"; stale comment "Nothing is uploaded" | accurate status; "SafeWatch checks only the words and phrases you list; other categories are not supported"; comment corrected |
| `CustomFilters.tsx`, `ProductGuide.tsx` | described only files | add the YouTube case: matching happens in the browser, nothing goes to the server, never to YouTube |
| Navigation | "Safety" | "Privacy" (the section is "Privacy and limits") |

Existing tests whose assertions pinned the OLD wording were updated for the new wording: `App.test.tsx` (card names, nav label), `CustomFilters.test.tsx` (note text; the "never sent" regexes now forbid claims that data never reaches the server instead of forbidding the true statement "never sent to YouTube"), `UploadDropzone.test.tsx` (alert text). No assertion about behaviour was weakened.

## 2. Touch targets (measured in a real browser; 44 px = `--sw-touch`)

Method: a script lists every visible link, button, input, select, summary, switch and tab, counts a checkbox's label as its hit area and counts an invisible `::before` extension of a button's clickable area, and reports anything under 44 px, at 320, 375, 768 and 1280 px, in three states: landing page, local file analysed, YouTube loaded with captions (and a visible warning at 320 px).

Found before: logo link 29 px high; navigation links 40 px (768 px); every playback/preference/default-action `select` 28 px; disclosure summaries 41 px (and smaller in the category lists); timeline finding marks 16 px; at 320 px the checkboxes were already ≥44 px through their labels. Fixed in CSS only (no visual redesign): `.sw-select` min-height, `.sw-details > summary`, `.sw-nav__link`, `.sw-wordmark`, finding timeline height and clickable area.

After: **no control under 44 px at any of the four widths in any of the three states, except one documented exception**: context-timeline segments (`.sw-cseg`, 24 px clickable height, lanes are 26 px apart). Every segment is also a full-size (84 px) entry in the list below, so the function is available at full size (WCAG 2.5.8, equivalent control). The warning card's Skip, Ignore and Dismiss buttons measured 104×44, 104×44 and 44×44 at 375 px. Inline text links are exempt. YouTube's own player controls are YouTube's and were not measured.

## 3. Other accessibility checks
- **axe-core 4.13** (already installed transitively through `eslint-plugin-jsx-a11y`; now declared as a devDependency: +1 line in `package.json` and the lockfile, no download, no runtime cost) was run in a real browser, including colour-contrast, at 320, 375, 768 and 1280 px on the landing page, the local-file analysis and the YouTube panel: **0 violations**. One transient "serious" colour-contrast report on the warning card appeared while the card was mid-fade (the embedded browser throttles CSS animations; opacity read 0 even 500 ms in); the card's real colours are about 15:1 (title) and 7:1 (detail) and a re-run found none. Treat that as an observation, not a proof.
- In tests (jsdom, rules that need layout disabled): the same pages and states, plus a visible warning, error state and rejected-link state: 0 violations; every interactive control on the landing page has an accessible name.
- **Keyboard** (real Tab key in the browser): order is skip link → logo → navigation → calls to action → source tabs (roving tabindex) → link field → Load video; every focused element showed a 2 px solid outline. Tabs use arrow/Home/End. Escape dismisses a warning from inside it (test).
- **Warnings**: announced once through a polite live region (re-render with time passing does not re-announce: test); the card is a labelled group; dismiss, Ignore and Skip are real buttons with names.
- **No horizontal overflow** at 320, 375, 768 and 1280 px in the landing page, the local-file result and the YouTube result (scroll width minus client width = 0).

## 4. Playback behaviour audit [V] (no defect found; semantics unchanged)
Real browser, local file (synthetic clip with speech at 25 s) and the real YouTube player (previous checkpoint's evidence still stands):
- **Dismiss (X)**: the card goes away, playback keeps running (advanced 1.0 s in 1.0 s), the finding's action stays "No action".
- **Ignore**: the finding becomes "ignore", playback continues, "Undo ignore" appears.
- **Skip** (a choice for the finding, armed from the warning or the list): the playhead jumped 26.45 → 27.83 s; status "Skipped 0:26.46 to 0:27.83". **Mute**: muted at 26.49 s, restored at 27.86 s.
- YouTube: warning ~20 s ahead, Skip 0:09→0:12 through `seekTo`, mute 71.05→76.02 s for 71.00→76.00 s cues (real `isMuted()`), unchanged by this checkpoint.
- "Skip" still means "jump past this finding when playback reaches it", not "+10 s". Unavailable capabilities (YouTube speech and scene categories) are listed as unavailable/unsupported with their reasons. The YouTube security restrictions (strict URL parsing, official API only, no download or overlay) were not touched.

## 5. Not done / not verified
- **No screen reader was used** (VoiceOver, NVDA, JAWS, TalkBack). Announcement behaviour was checked only through live-region attributes and tests.
- Colour contrast was machine-checked (axe) but not reviewed by eye for every state; reduced-motion and high-contrast modes were not tested in a browser; zoom to 200%/400% and text-spacing overrides were not tested; touch behaviour was emulated (mouse events), not on a physical device.
- The 28 px selects etc. are fixed, but YouTube's iframe controls, native `<video>` controls and the browser's own file dialog are outside SafeWatch's control.
- Only Chromium (the desktop app's browser) was used.
- Context-timeline segments remain 24 px (exception above).
- `PRODUCT_ACCEPTANCE_REPORT.md` items still open: no "+10 s" button, no swipe-to-dismiss gesture, no warning category beyond "flagged phrase".

## 6. Validation (final tree, run sequentially)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run lint` | 0 | clean |
| `npm run typecheck` | 0 | clean |
| `npm test` (twice) | 0 | 96 files, **1789 tests passed, 0 failed, 0 skipped** (YouTube checkpoint: 1748; +41: copy 20, touch-target stylesheet guard 14, accessibility 7) |
| `npm run build` / `npm run build:server` | 0 / 0 | built |
| `npm run eval:safety` | 0 | unchanged |
| `npm run check:playback` | 0 | passes |
| `npm audit` | 0 | 0 vulnerabilities |

## 7. Git
One commit `fix: improve SafeWatch accessibility and product clarity`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`.
