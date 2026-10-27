# CHECKPOINT 13 REPORT: +10 s Button and Swipe-to-Dismiss

Parent commit `7c8ddeab2b90fb803236d4f75f304dfb73588809`. Two small, additive playback controls; no change to Skip, mute, warning scheduling, analysis, security or privacy behaviour.

## 1. What was built
- **"+10 s" button** under the player, for local files and YouTube (accessible name "Skip forward 10 seconds", 44 px tall). Pure rule `forwardTarget` (`src/domain/playback/seekForward.ts`): current position + 10 s, clamped to the length when it is known, never backward, no move (and a spoken explanation) at the end or when the position is unknown. The seek goes through the same path as the finding list's "Play from just before". Disabled, with the reason, when there is no player (file gone, browser cannot play it, YouTube player not ready or in error). Announced through the existing live region ("Skipped forward 10 seconds, to 0:13.00.").
- **Swipe to dismiss** on the warning card (`swipe.ts`, `useSwipeToDismiss.ts`, `UpcomingWarning.tsx`, CSS): a sideways drag of at least min(80 px, 30 % of the card) with touch, pen or mouse dismisses exactly as the X button does; a shorter drag springs back; a mostly vertical movement scrolls the page (`touch-action: pan-y`); taps and the buttons inside the card are unaffected; the click that ends a drag is swallowed; the countdown is held while dragging; no animation under reduced motion. The X button and Escape remain.
- The warning slot keeps its fixed height (no layout shift). The button sits directly under the player; the heads-up place follows it.

## 2. Semantics, checked rather than assumed
- **+10 s is the viewer's own seek.** The coordinator already respects a user's jump into a skip span (no trap, no loop), the scheduler re-reads the position, mute follows position. Tests: landing inside a skip span → one seek only (the user's), no automatic skip afterwards; jumping past a finding → no stale warning and no skip; jumping out of a muted span → sound restored; a visible warning is neither dismissed nor answered by +10 s, and no choice is made for the finding.
- **The warning's "Skip" button is unchanged**: it sets the finding to skip; it is not +10 s.
- **Swipe never acts on playback**: no seek, no mute, no choice, playback keeps running (tests on both local video and YouTube).

## 3. Validation (final tree, run sequentially)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run lint` | 0 | clean |
| `npm run typecheck` | 0 | clean |
| `npm test` (twice) | 0 | 100 files, **1840 tests passed, 0 failed, 0 skipped** (previous checkpoint 1789; +51: `seekForward` 8, `swipe` 8, warning swipe component 13, local +10 s and in-panel swipe 15, YouTube +10 s and swipe 7) |
| `npm run build` / `npm run build:server` | 0 / 0 | built |
| `npm run eval:safety` | 0 | unchanged |
| `npm run check:playback` | 0 | passes |
| `npm audit` | 0 | 0 vulnerabilities |

One existing assertion was adjusted: `PlaybackWarnings.test.tsx` required the warning slot to be the element directly after the player; it now requires player → `+10 s` row → slot (same intent: keyboard order follows the video controls). No other existing test changed, and no dependency changed.

## 4. Real-browser verification (Chromium in the desktop app; the real YouTube player for the YouTube parts)
- **Local file (375 px):** 3.0 s paused → 13.0 s, still paused; while playing, +10 s adds 10 s plus the elapsed playback and keeps playing; at 36 s (length 40 s) it lands on 40 s and does not go past. Button 293×44 on the narrow upload layout (existing rule makes buttons full width there), 80×44 elsewhere.
- **Real YouTube player:** 2.0 s → 13.4 s → 24.8 s on two presses (each +10 s plus about 1.4 s of playback during the 1.5 s wait); the player stayed in the playing state.
- **Swipe, local and YouTube:** a real mouse drag of about 110 CSS px across the card removed it (within 0.1 s of it appearing on the local video; confirmed gone 1.5 s later on YouTube, before its 3 s expiry), while the video kept playing, was not muted and the finding's choice stayed "No action". A drag of about 20 CSS px left the card in place and it settled back (`is-settling`, no transform left).
- **Layout and accessibility** (axe-core in the real browser plus the 44 px audit): no violations, no control under 44 px, no horizontal overflow at 375, 320 and 1280 px with the YouTube panel loaded; the jsdom axe tests cover the new button as well.
- Console errors: none.

## 5. Not verified / limits
- **Touch:** the embedded browser sends mouse events for pointer input, so swipe was tested with real mouse drags and with synthetic touch, pen and mouse pointer events, not on a physical touch screen (browser-specific touch behaviours such as scroll interception were not observed).
- No screen reader was used; announcements were checked through live-region text and tests.
- The step is fixed at 10 s; there is no keyboard shortcut beyond activating the button; there is no "back 10 s".
- Advertisements and other restricted YouTube cases remain as documented in `CHECKPOINT_11_REPORT.md`.

## 6. Git
One commit `feat: add +10s skip button and swipe-to-dismiss`, normal push to `origin/main`, verified with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main`.
