# CHECKPOINT 4 REPORT

Scope: speech-to-text, subtitle text, a merged timestamped text timeline, and a custom-term detection foundation. **Text evidence only.** No safety classification, scoring, verdict, visual AI, muting, censoring or media alteration exists.

## 1. Starting Git State

Verified before any change: branch `main`; working tree clean; `origin` = `https://github.com/anubavkonda21/Safe-Watch.git`; local `HEAD`, `origin/main` and `git ls-remote origin refs/heads/main` all `16c271bdfc6ed14616ac794bfa68869079f1b113` (`feat: add media extraction pipeline`).

## 2. AI Provider Evaluation

Full table in `SAFEWATCH_MEDIA_ARCHITECTURE.md` §26.1. Summary:

| Option | Verdict |
| --- | --- |
| **whisper.cpp** (Whisper family, native C++, Metal on Apple Silicon) | **Chosen**: local, one executable, no Python/GPU, word-alignment support, multilingual |
| faster-whisper (CTranslate2) | Same models; CPU-only on Apple Silicon; needs a Python runtime we do not otherwise need |
| OpenAI Whisper (PyTorch) | Heaviest install, slower on CPU |
| Hosted speech API | Rejected for now: audio would leave the machine; per-minute cost. The port makes it a later swap |
| Vosk / other local engines | Lower accuracy, weak punctuation |

Considered against the brief's criteria: accuracy, timestamp quality, multilingual and Hindi/Indian-English performance (measured, §17), CPU/Apple Silicon support, install complexity, latency, privacy, cost, portability, model size.

## 3. Selected Speech Model

- **Engine:** whisper.cpp **1.9.4** (Homebrew `whisper-cpp`; Homebrew also installed its own libraries `ggml 0.25.3`, `llama.cpp 0.5.0` and `sdl2-compat`).
- **Model:** multilingual `ggml-base.bin`, **141.1 MB**, SHA-1 `465707469ff3a37a2b9b8d8f89f2f99de7299dac` (matches the checksum published by the whisper.cpp project; verified by the download script), SHA-256 `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`. Not committed (`models/` is git-ignored).
- **Why base:** the smallest sensible model that is multilingual. English and Indian-accented English were good; running at 16–50× real time on this laptop. **Why not bigger:** the brief asks for the smallest sensible option. **Honest trade-off:** Hindi on `base` comes out in Urdu script; `small` (465 MB, SHA-1 `55356645c2b361a969dfd0ef2c5a50d530afd8d5`) fixes the script at about 3× the time. It is a configuration change (`scripts/download-speech-model.sh small`), no code change.
- **Reproduce:** `brew install whisper-cpp`; `scripts/download-speech-model.sh`; set `SAFEWATCH_SPEECH_PROVIDER=whispercpp` and `SAFEWATCH_SPEECH_MODEL_PATH=models/ggml-base.bin`.

## 4. Architecture

```
 MediaExtraction (completed) ──► TextAnalysisService (own bounded queue, default 1 job)
        │ AudioAsset, SubtitleTrack                  │ policy: track selection, limits, timeouts, cleanup
        │                                            ├─► SpeechToTextProvider (PORT) ◄─ WhisperCppProvider ─► whisper-cli ─► model file
        │                                            │        raw, provider-neutral, UNTRUSTED transcription
        │                                            ├─► normalizeTranscription + validateTranscript  → Transcript
        │                                            └─► TextEvents → buildTimeline → alignText     → TextAnalysis.timeline
 shared pure domain: src/domain/speech (Transcript, normalisation, track selection)
                     src/domain/text   (TextEvent, alignment, CustomFilter, TextMatch, TextAnalysis lifecycle)
```

- **No Python:** the model runs in a separate native process behind the port, so there is no Node/Python tangle. The application never sees engine commands, model paths, JSON from the engine, or credentials.
- **Three separate states plus safety:** MEDIA (`ready`), EXTRACTION (`completed`), TEXT (`not_started → queued → processing → ready | failed`, phases `preparing → speech-processing → building-timeline`) and the overall safety ANALYSIS (still `not_started`). `Text: ready` means "text evidence is available", not "analysis complete".
- **Reuse:** extraction output (`AudioAsset`, `SubtitleCue`) is consumed unchanged; the process runner, queue, storage port (one new `withArtifactFile` callback), record, API server and polling pattern are extended, not rebuilt.

## 5. Audio Track Selection

Deterministic, tested policy (`selectAudioTracks`): candidates are tracks with a stored file (bit-identical duplicates are listed as `duplicate`). Priority: (1) language: configured language, then unknown, then others (container tags like `eng`/`hin` map to `en`/`hi`); (2) the container's default track; (3) not commentary/hearing-impaired; (4) container order. `SAFEWATCH_SPEECH_MAX_TRACKS` (default 1) are transcribed; **every other track appears in the result with a reason** (`not-selected`, `duplicate`, `speech-disabled`). Each result keeps track id, stream index and container language. Several tracks can be transcribed (tested with 2). Verified end to end with a real Hindi(default) + English two-track file: auto selects the Hindi default track; `language=en` selects the English track.

## 6. Transcript Model

`Transcript { mediaId, audioTrackId, streamIndex, language, languageConfidence, durationSeconds, segments[], hasWordTimestamps, wordTiming, provider{name,model}, issues[] }`; segment `{ index, startSeconds, endSeconds, text, originalText, confidence, words[]|null }`; word `{ startSeconds, endSeconds, text, confidence }`. Normalisation is deterministic: NFC, controls/zero-width/bidi removed, whitespace collapsed, provider text kept as `originalText` only when it differed; invalid-timestamp, empty and duplicate segments dropped **and counted**; overlaps kept and counted; unreliable word lists discarded for that segment (counted); words and punctuation never "corrected". Confidence is the mean engine token probability (a model probability, not calibrated) and `null` when absent: never invented (tested). Language is the detected two-letter code; speech is never translated.

## 7. Timestamp Handling

Media time in seconds, rounded to whole milliseconds (the engine reports 10 ms steps); no frame numbers. **Accuracy was measured against audio with known ground truth** (2.000 s of silence + a 1.823 s sentence + exactly 1.500 s of silence + a 2.450 s sentence, built from exact pieces):

| | first word | second sentence onset | true |
| --- | --- | --- | --- |
| whisper.cpp decoder timestamps | **0.00 s** (error −2.00 s) | 4.00 s (error −1.32 s) | 2.00 / 5.32 s |
| **DTW word alignment (adopted)** | **2.08 s** (+0.08 s) | **5.40 s** (+0.08 s) | 2.00 / 5.32 s |

On the adapter path with a different clip (speech, 1.5 s pause, speech) the second sentence began at 3.42 s vs a true 3.32 s (+0.10 s). Therefore alignment timing is the default and each transcript records `wordTiming: alignment | decoder`. **Limits, stated plainly:** word START times are the reliable part; a word's END is only an upper bound (the next word's start; the last word of a segment is capped at +1.0 s, e.g. "here." ended at 2.64 s although speech ended near 1.82 s); neighbouring words can share a start time; segment boundaries from the decoder can stretch across pauses. Do not use word ends as exact mute boundaries without further work (see §25).

## 8. Subtitle Integration

Reuses Checkpoint 3's normalised cues unchanged. Only text tracks whose text was extracted yield events; image, unknown and failed tracks contribute none (tested, including with the real PGS track). Subtitle events keep language, track and stream index, and have `confidence: null` and no words.

## 9. Text Event Timeline

`TextEvent { id, source: speech | subtitle, startSeconds, endSeconds, text, language, trackId, streamIndex, confidence, words, evidence }`, ordered deterministically (time, then speech before subtitle, then id). **Alignment** (no semantic AI): a speech event and cue(s) are linked only if within 1 s, in compatible languages, and their words overlap (Dice ≥ 0.6); speech is compared with all nearby cues together (cues split sentences), and cues covering several segments are linked by a reverse pass. Result per event: `both`, `speech-only` or `subtitle-only`. Verified with real data: the real transcript of the fixture marked both spoken and written lines `both` and the written-only cue `subtitle-only`. **A real integration bug was found and fixed:** subtitles carry three-letter tags (`eng`) while the model reports `en`, which made identical text unlinkable; the aligner now compares primary languages through the shared mapper (regression tests added).

## 10. Custom Filter Foundation

`CustomFilter { id, phrase, normalizedPhrase, matchMode, enabled, createdAt }`; modes: `exact` (case-sensitive contains), `case-insensitive` (contains), `word-boundary` (whole words), `phrase` (whole words, spacing/punctuation tolerant). **Normalisation for matching:** NFKC, control/zero-width/bidi removed, curly quotes straightened, whitespace collapsed, optional case folding; punctuation handled by word tokenisation (inner apostrophes kept); diacritics deliberately **not** stripped; non-Latin scripts preserved. `TextMatch { filterId, phrase, source, trackId, eventId, startSeconds, endSeconds, matchedText, confidence, granularity (word|segment|cue), matchMode }`. Word-level times when words exist, otherwise the whole segment or cue, honestly labelled. Confidence = lowest known word confidence, `null` if unknown and always `null` for subtitles. Matching is pure and bounded, treats phrases as text (no regular expressions are built from user input; tested with `.* $( ) [ ] \`) and never mutates input. It searches transcript words, segments and subtitle cues. Validation: 1–200 characters, at least one word, no duplicates (normalised form + mode), at most 100 filters; stored data re-validated on read.

## 11. API

- `GET /api/media/:id/transcript` → `{ textAnalysis }` (status, phase, per-track speech results with transcripts, timeline, alignment counts/links, provider name+model, issues, metrics). `?words=false` omits word timestamps (1.7 MB → 408 KB for 55 minutes). 404 for unknown/malformed ids; other methods 404.
- `GET /api/media/:id` now carries `text: {status, phase}` beside `asset`, `extraction`, `analysis`.
- `GET /api/health` adds `speech: {provider, available}` only.
- Never exposed (asserted): model paths, command lines, engine output, filesystem paths, credentials, stack traces.

## 12. Frontend

- **Transcript panel** inside the media card after extraction completes: phase text ("Waiting to transcribe…", "Transcribing speech…", "Building the text timeline…", no percentages), a summary (speech segments + language, subtitle cues, word timing), **Custom filter matches** (time range, source, matched text, filter, confidence when known), and an expandable timeline (media timestamps, source, "speech + subtitle" evidence, match marker, confidence only where it exists, 50 rows at a time) with notes about audio tracks that were skipped or failed. Status badges: `Media · Extraction · Text · Analysis: not started`. Failures are their own red alert while media stays ready. Copy never claims safety (asserted).
- **Custom filters section** (own section, "Choose words or phrases SafeWatch should detect."): labelled input (Enter adds), match-mode select with a one-line explanation, Add button, compact rows with phrase, mode, an accessible on/off switch and a remove button; validation messages tied to the input (`aria-invalid`, `aria-describedby`); duplicate and empty prevention; filters persist in this browser (`localStorage`, guarded against private mode/quota/corrupt data). Says plainly it only detects. On narrow screens the visible "Enabled" label is hidden (state remains in the switch and its accessible state).
- Design tokens, typography, spacing, radii and status colours reused; no landing-page redesign.

## 13. Privacy

- **Audio processing:** locally, on the machine running SafeWatch, by a whisper.cpp process. **Audio is not sent to any third party.** The model is a local file; the only network use is the developer's one-time model download from Hugging Face.
- **Transcripts:** held in server memory inside the media record and returned by the API; never logged (logs: ids, counts, durations, codes); not persisted by the page. **One disk exception:** the engine writes its result JSON (which contains the transcript) into a private temp directory (mode 0700, verified by a test) that is deleted right after it is read and on every failure/abort path; a crash mid-run can leave it until the next start, which sweeps stale `sw-whisper-*` directories older than an hour (tested). Audio is read in place, not copied.
- **Retention:** the media's 60-minute clock. Deleting or expiring media deletes transcripts and the timeline, and aborts transcription in progress (tested). Restart discards everything.
- **Browser:** custom filters stay in the visitor's browser; matching runs there; filters are never sent to the server.
- **Not claimed:** the hosting machine can read what it processes; there is no authentication, per-user isolation or encryption at rest yet.

## 14. Security

- **No user text reaches a command:** the engine command line holds only a server-generated audio path, the configured model path, a validated language code (`^[a-z]{2,3}$`) and fixed flags; injection attempts (`en; rm -rf /`, `--translate`, `../../x`) are rejected (tested). Same hardened runner as FFmpeg (`shell:false`, argument arrays, minimal environment, closed stdin, capped output, kill on abort).
- **Transcript text is untrusted data:** normalised, rendered only as text (React), never as HTML (tests inject `<script>`, `<img onerror>`, `$(rm -rf /)`, bidi overrides and control characters through transcript, subtitle, track titles and filter phrases), never interpolated into commands, never logged. Language values from the model are reduced to a safe tag.
- **Resource limits:** per-track timeout (10 min), duration (3600 s) and size (256 MB) limits checked **before** the engine starts, one transcription at a time, bounded queue (overflow → `server-busy`), engine output capped, 20,000 segments and 2,000 characters per segment caps.
- **No zombies:** on timeout/cancel the engine process is killed (a test asserts the pid is gone) and its temp directory removed. Provider crashes, corrupt audio (the engine exits 0 without output, handled), malformed JSON, missing timestamps and unsupported languages become typed errors without stack traces or paths.
- **Dependencies:** no npm dependency added. Config rejects a provider without a model path and malformed language values at startup.

## 15. Tests

`npm test` (Vitest, web + server projects): **598 passed, 0 failed, 0 skipped** (web 350 in 27 files; server 248 in 15 files). Checkpoint 3 had 381; **+217**. Lint and typecheck: clean. After the test-isolation fix the full suite passed 6 consecutive times (596 tests); two further provider tests were then added and the final 598-test run passed, with the provider test file re-run 3 more times without failure. Real-model tests self-skip (and would be reported as skipped) if the engine/model are absent; none were skipped.
- **Domain:** transcript validation and timestamps; normalisation (malformed, missing, negative, NaN, overlapping, duplicate, unreliable word timing, hostile text); track selection; matching normalisation; custom-filter creation/duplicates/storage; all four match modes, Unicode (NFC/NFD, fullwidth, curly apostrophes, Devanagari, bidi), word vs segment vs cue granularity, confidence, metacharacter safety, determinism, bounds; alignment (pair, speech-only, subtitle-only, split cues, covering cue, language rules, `eng`=`en`); text-analysis state transitions; event builders.
- **Provider/adapter:** real captured whisper.cpp JSON parsing; fake-engine failure modes (exit codes, missing output, malformed/wrong JSON, oversized output, timeout/cancel with process-death check, missing binary/model, injection through language, private temp dir, stale sweep, no leakage).
- **Service/API:** subtitle-only, speech+subtitle, no audio, silence, speech disabled, multi-track selection, per-track failures (all error codes), malformed responses, limits, timeout, cancellation on delete, concurrency bound, queue-full, retention/expiry, hostile transcript, no path/log leakage, transcript endpoint states, `words=false`, health.
- **Frontend:** transcript panel (states, matches, timeline, pagination, skipped tracks, inert hostile text), custom filters UI (add by Enter/button, validation, duplicates, toggle by mouse/keyboard, remove, persistence, corrupt/failed storage), uploader polling, reducer events, full flow into the transcript, timecode formatting.
- **Mobile layout** is verified in a real browser, not in jsdom.

## 16. Real AI Inference Test

Real whisper.cpp 1.9.4 + `ggml-base`, Apple M5 (16 GB), 4 threads, through the **full pipeline** (HTTP upload → storage → FFprobe → extraction → real model → normalised transcript → timeline → API), performed in tests and with `npm run check:speech`.

| Sample | Audio | Inference | Language | Output |
| --- | --- | --- | --- | --- |
| `speech-en.mp4` (US English voice, synthetic) | 5.2 s | **321 ms** (RTF 0.06, 16× real time) | `en` | "Hello, this is a safe watch test, the quick brown fox jumps over the lazy dog." — 1 segment, 16 words with start/end, segment confidence 0.89 |
| 54.7-minute generated speech video | 3282.6 s | **65.6 s** (RTF 0.02, **50× real time**; end to end 75.4 s) | `en` | 743 segments, 8,030 words, 55,207 characters |

Timestamp behaviour on the short clip: words start at 0.30 s ("Hello,") and end at 5.00 s; starts are monotonic and inside the audio; ends are upper bounds (§7). The real transcript of the short clip: `Hello,(0.30–0.88) this(0.88–1.10) is(1.10–1.28) a(1.28–1.48) safe(1.48–1.76) watch(1.76–2.38) test,(2.38–2.56) the(2.56–2.82) quick(2.82–3.12) brown(3.12–3.54) fox(3.54–3.80) jumps(3.80–4.10) over(4.10–4.26) the(4.26–4.52) lazy(4.52–4.92) dog.(4.92–5.00)`. Memory: engine RSS peak **363 MB** (short) and **949 MB** (55 minutes); Node heap 10 → 12 MB (short), 9.8 → 17 MB (55 min); Node RSS 98 / 120 MB. Silence (6 s) and pink noise (5 s) produced **no segments** (no invented text) both directly and through the pipeline.

## 17. Accuracy Baseline

All test speech is **synthetic (macOS text-to-speech voices)**, not real recordings: a baseline, not a benchmark, and it flatters the model (clean, steady voices).

| Sample | Model | Result | Word error rate |
| --- | --- | --- | --- |
| English, US voice | base | "Hello, this is a safe watch test, the quick brown fox jumps over the lazy dog." | **0.13** (2 edits / 15 reference words; the only error is "SafeWatch" → "safe watch") |
| English, Indian-accent voice (Rishi) | base | identical text | **0.13** (same single error) |
| Hindi (Lekha): "नमस्ते, यह एक परीक्षण है। मुझे हिंदी बोलना पसंद है।" | base | language detected **`hi`**; text in **Urdu script**: "نمستے یہ ایک پریکشن ہے / مجھے ہندی بولنا پسند ہے" | not comparable (script differs from the Devanagari reference); phonetically close, words partly wrong |
| Hindi | **small** (run with the engine CLI, not through SafeWatch) | Devanagari: "नमस्ते, ये एक परिक्षन है, मुझे हिंदी बुलना पसन्द है" | **0.40** (4 of 10 words differ) in ≈1.0 s for 4.1 s of audio |
| Hindi/English code-switching (Lekha reading "मुझे यह movie बहुत पसंद आई, it was really great.") | base | detected `en`; "I love this movie, it was really great." | **Not a faithful transcript:** the Hindi part was rendered as an English paraphrase (effectively translated) |
| same | small | all transliterated into garbled Devanagari "मुजे यह मुवी बहुत पसंट आई, यह वो जाए ग़ाई ग़ाई।" | Not usable |
| silence, noise | base | no text | n/a |

**Conclusions, not claims:** English (including this Indian-accented voice) is usable; Hindi needs `small` and is still imperfect; **mixed Hindi/English speech is not supported by either model**; one language is reported per track; names and brand terms may be split ("safe watch"). Real-world accents, noise, music and overlapping speech were **not tested**. A test records the code-mixed behaviour without asserting quality.

## 18. Custom Phrase Demonstration

Real transcript + real subtitles (`speech-subs.mkv`), filter **"SafeWatch"**, deterministic and tested end to end (and shown in the UI):

| Mode | Source | Matched text | Start → end | Granularity | Confidence |
| --- | --- | --- | --- | --- | --- |
| `phrase` | **speech** | "safe watch" | 1.50 → 2.38 s | word | 0.50 (lowest word) |
| `phrase` | **subtitle** | "SafeWatch" | 0.30 → 2.90 s | whole cue | null |
| `word-boundary` | subtitle only | "SafeWatch" | 0.30 → 2.90 s | whole cue | null (it does **not** match the model's "safe watch") |

The expected position of the spoken phrase in the audio is about 1.2–2.0 s: the reported start (1.50 s) and end (2.38 s, an upper bound) are consistent with it. A second filter "quick brown" matched speech (2.84–3.54 s, 0.84) and the subtitle cue (3.00–5.40 s). **Nothing was muted, censored, hidden or altered**: the response is read-only evidence.

## 19. Performance

| Measure | Result |
| --- | --- |
| Model start-up | ≈ **240 ms** per transcription (process start + model load, measured with 0.5 s of audio, 5 runs: 241–265 ms); the model is reloaded each job |
| Inference | 321 ms for 5.2 s; 65.6 s for 54.7 min (RTF 0.06 → 0.02, i.e. 16× → 50× real time) |
| Peak memory | engine RSS 363 MB (short) / 949 MB (55 min); Node heap +2–7 MB; Node RSS 98–120 MB |
| API/Node impact | transcription runs in a child process; Node stayed responsive; peak 1 engine process (concurrency 1) |
| Transcript size | 55 min: 55 KB of text; API payload 1.7 MB with word timestamps, 408 KB without (`?words=false`); short clip 3.8 KB / 1.4 KB |
| Frontend bundle | JS **315.89 kB (99.05 kB gzip)**, CSS **22.85 kB (5.27 kB gzip)**. Checkpoint 3: 297.67 kB (94.04 gzip) / 19.48 kB (4.75 gzip). **+18.22 kB JS (+5.01 gzip), +3.37 kB CSS (+0.52 gzip)** (domain matching/alignment, transcript panel, filters UI) |
| Server bundle | 113.86 kB (34.72 kB gzip); Checkpoint 3: 75.28 kB |
| UI with 743 segments | 50 rows rendered at a time, 654 DOM nodes, JS heap 18 MB |

## 20. Visual Verification

Real browser, real API, real model, real uploads: **320, 375, 768, 1024, 1280 and 1440 px**. No horizontal overflow at any width; transcript, matches, timestamps and the filters section checked at each (filter form 3 columns from 768 px, stacked below; a 100-character filter phrase wrapped correctly at 320 px; the empty-input error appeared; the mobile menu control is hidden from 768 px). Verified live: waiting/transcribing state, ready transcript with matches from both sources, a genuine `server-busy` failure, pagination with 743 segments, and the empty-input validation.
Screenshots (committed in `docs/screenshots/`):
1. `checkpoint-4-1-transcribing-in-progress.jpg`: Media READY · Extraction COMPLETED · Text IN PROGRESS · Analysis NOT STARTED.
2. `checkpoint-4-2-transcript-and-matches-desktop.jpg`: matches (speech and subtitle) and the timeline.
3. `checkpoint-4-3-text-analysis-failed-server-busy.jpg`: failure with media still ready.
4. `checkpoint-4-4-transcript-mobile-320.jpg`: transcript at 320 px.
5. `checkpoint-4-5-custom-filters-mobile-320.jpg`: custom filters at 320 px.
Not captured at every width: the in-progress and failed states (checked at one width); some small CSS refinements after screenshots 2 and 4 were re-verified by measurement and a re-take of 2 and 5.

## 21. Dependencies

- **npm: none added.** Scripts added: `check:speech`.
- **System (documented separately, not npm and not Python):** `whisper-cpp` 1.9.4 via Homebrew, pulling `ggml` 0.25.3, `llama.cpp` 0.5.0, `sdl2-compat`; the **model file** `ggml-base.bin` (141.1 MB; checksum above), downloaded by `scripts/download-speech-model.sh` (new, verifies SHA-1, refuses mismatches). An optional `ggml-small.bin` (465 MB) was downloaded to `/tmp` for comparison only.
- **Evaluation of the choice:** necessary (a speech model is the feature); maintained project; MIT licensed; runs as an isolated process; larger on-disk footprint than a Node library but zero impact on the web bundle.

## 22. Known Limitations

- **Hindi:** `base` writes Hindi in Urdu script; `small` is much better but still has errors (WER 0.40 on one sentence). **Code-switched speech is not handled by either model.**
- **Word timing:** starts are good (≈0.1 s in tests); **ends are upper bounds**; neighbours can share a start; the engine's DTW mode required disabling flash attention (a small speed cost not measured separately); not validated on noisy, music-heavy or overlapping speech, or on real recordings.
- **Test speech is synthetic.** Real-world accuracy, accents beyond one Indian-English voice, background noise and long-form real speech are untested.
- **Brand/term splitting:** "SafeWatch" was heard as "safe watch"; `phrase` mode compensates, `word-boundary` does not. Phonetic or fuzzy matching is not implemented.
- **One language per track;** the model may paraphrase foreign passages (observed).
- **Model reloads for every job** (≈0.24 s); a resident server process is not implemented. The 55-minute run used 949 MB of engine memory; there is no memory limit on the engine.
- **State is in memory:** transcripts vanish on restart; filters are per browser (no accounts, no sync); no server-side filter storage or matching API.
- **Subtitle styling and image subtitles** remain unsupported; no OCR.
- **Alignment** is lexical and time-based; heavily paraphrased subtitles will not be linked.
- **Not tested:** Linux, GPU/other engines, models other than `base`/`small` (and `small` only via the engine CLI), concurrent transcriptions above 1, the speech temp-directory behaviour across a real crash (simulated with leftover directories).
- Roadmap renumbering: Checkpoint 5 (custom detection) now builds on this foundation rather than starting from scratch.

## 23. Security Risks Remaining

**Unchanged production gates (NOT solved by this checkpoint):**
1. **FFmpeg isolation is NOT COMPLETED**: no OS sandbox, no separate FFmpeg user, no CPU/memory cgroup.
2. The same applies to **whisper.cpp**: it parses untrusted audio in a process with the server's privileges, no sandbox, no memory cgroup (949 MB observed on 55 minutes).
3. **No production authentication or authorisation**: media ids are bearer tokens; anyone can upload within limits and read any transcript whose id they know.
4. **No rate limiting** beyond global concurrency caps.
5. **No disk quota** (extraction and temp directories).
Additional: transcript and subtitle text are sanitised and rendered as text, but any future consumer (AI prompts, exports, HTML) must treat them as untrusted (prompt injection through spoken or subtitle text is a real risk for later checkpoints); the model file is trusted on checksum only (no signature); `localStorage` filters are readable by anything running on the page's origin.

## 24. Privacy Risks/Considerations

Speech and transcripts can contain personal or sensitive content. They remain on the host and in server memory for at most the retention window, but: the host operator can read them; there is no per-user isolation, encryption at rest or audit log; a crash can briefly leave transcript JSON in a private temp directory until the next start; API responses are plain JSON over HTTP (TLS is the deployment's job); the browser holds the full transcript in page memory while open; custom filters (which may themselves be sensitive terms) live in the browser's `localStorage` unencrypted. If a hosted provider is ever added behind the port, **audio would leave the machine** and this document, the UI copy and consent flows must change first. Retention is a product decision still to be made.

## 25. Future Censorship Boundary

The detection contract is `TextMatch { source, trackId, startSeconds, endSeconds, matchedText, confidence, granularity }` computed over the aligned timeline. A future filtering engine can consume it **without changing today's code**:
- **Audio muting / beeping:** for `source: speech` and `granularity: word`, mute `[startSeconds, endSeconds]` of the audio track `trackId` (stream index known). Because word starts are reliable but ends are upper bounds (§7), a future checkpoint must add end-time refinement (for example energy-based end detection on the extracted WAV) and a safety margin policy before relying on exact edits. For `granularity: segment` the whole segment span is the only safe bound.
- **Subtitle censoring:** for `source: subtitle`, `eventId` and the cue span identify the cue to rewrite or hide; because subtitle matches are whole cues, partial-cue masking would need the matched character range (not yet recorded; `matchedText` plus the cue text is enough to derive it).
- **Timeline markers:** matches map directly to markers on the media timeline; `evidence: both` lets the UI show when speech and subtitles agree, and `confidence` lets it flag shaky detections.
- **Policy:** `CustomFilter` already carries mode and enabled state; user policies, presets and actions (mute vs warn vs skip) are a later layer between matches and actions.
None of this is implemented: **no media is muted, censored, hidden, skipped or altered, and no match is treated as a verdict.**

## 26. Git

- Commit message: `feat: add speech and subtitle intelligence foundation`
- Commit hash, push result, local/remote synchronization and working-tree status: reported in the final message after verification with `git rev-parse HEAD`, `git rev-parse origin/main`, `git ls-remote origin refs/heads/main` and `git status -sb` (a commit cannot contain its own hash).
- Remote: `origin` → `https://github.com/anubavkonda21/Safe-Watch.git`; normal push to `main`; no force.
- Staging review: no `.env`, no credentials, no model weights (`models/` ignored), no recordings or long-form transcripts, no build output; fixtures are small synthetic clips (≈400 KB total), one trimmed real engine JSON (1.7 KB, contains only the synthetic sentence), and five screenshots.
