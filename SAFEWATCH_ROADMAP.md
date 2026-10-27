# SafeWatch Roadmap

Each checkpoint is reviewed before the next is started. Scopes below are intent, to be refined from what each previous checkpoint actually discovers.

| # | Checkpoint | Intent | Status |
| --- | --- | --- | --- |
| 0A | Project Foundation | Stack, architecture, design system, landing page, local upload component, tests | DONE |
| 1 | Media Ingestion | Architecture decision (Node API + FFmpeg, phased), media domain model, ingestion state machine, `MediaProcessor` port, content-sniffing validation, browser metadata adapter | DONE |
| 2 | Server Media Foundation | Node API, streamed upload, temporary storage lifecycle, FFprobe metadata, FFmpeg decode check, `AnalysisJob` boundary, upload progress UI | DONE |
| 3 | Media Extraction Pipeline | Audio (WAV), subtitle cues, capped frame sampling, extraction manifest/API/UI, limits, cleanup, determinism | DONE |
| 4 | Speech + Subtitle Intelligence Foundation | Local speech-to-text (whisper.cpp) behind a port, transcript model with word timing, track selection, speech/subtitle timeline and alignment, custom-filter model with deterministic match detection, transcript and filters UI. Text evidence only | DONE |
| 5 | Visual Intelligence Foundation | Local image model (Apple Vision) behind a `VisualAnalysisProvider` port; timestamped visual observations (labels, located people/animals, recognised text) per sampled frame; visual timeline and API; frame preview UI; unified-evidence projection. Visual evidence only: no safety classification | DONE |
| 6 | Cross-Modal Context & Temporal Reasoning Foundation | Deterministic temporal correlation of speech, subtitle and visual evidence into context events with provenance, explanation and per-source confidence; context API and timeline UI. Grouping by time only: no safety classification | DONE |
| 7 | Safety Classification Foundation | Taxonomy v1, a typed finding contract (status, evidence references, explanation, abstention), a replaceable classifier port, and the first real classifier: flagged terms in speech and subtitles (rule based). Labelled evaluation fixtures, API and UI. Sexual content, violence, graphic injury and drug-related content are NOT supported: no feasible local classifier exists yet (documented blocker) | DONE (flagged terms only) |
| 8 | Playback Safety Actions | Plays the user's own file in the browser and applies user-chosen mute or skip to supported findings (flagged terms), with per-finding overrides, a master switch, deterministic interval handling and an explanation of each action. No server change, no editing of the media. Only findings that exist today (flagged terms in speech and subtitles) can trigger an action | DONE (flagged terms only) |
| 9 | Complete Product Experience | Pre-emptive warning shortly before a supported finding (reusing the Checkpoint 8 Skip/Ignore actions), a saved custom-phrase workflow (add, edit, remove, saved/active state), validated local preferences, local-only missed-finding feedback, honest onboarding and analysis status, accessibility and layout polish. No new detection and no new category | DONE (flagged terms only) |
| 10 | YouTube Player Integration | Paste a YouTube link (watch, youtu.be, Shorts), watch it in YouTube's own embedded player, and check the user's phrases against a caption file the user provides, with warnings, skip and mute through the existing playback engine. Speech and scene analysis are NOT possible for embedded YouTube video through permitted means; unsupported categories stay unsupported (`SAFEWATCH_MEDIA_ARCHITECTURE.md` §33) | DONE (player + user-supplied captions only) |
| 11 | Truthful UI & Accessibility Pass | Landing page and interface copy corrected to match the application (uploads, YouTube, unsupported categories); touch targets at least 44 px (one documented exception); axe-core scans, keyboard and overflow checks at four widths; no screen-reader testing, no compliance claim (`CHECKPOINT_12_REPORT.md`) | DONE (partial: no screen-reader or zoom testing) |
| 12 | Custom Word/Phrase Detection (remaining) | Builds on Checkpoints 4 and 9 (matching, local list workflow exist): server-side/shared filter lists, profanity baseline lists, better handling of mixed-language and misheard terms | PLANNED |
| 13 | Visual Content Detection | Needs a genuine local visual or multimodal classifier for violence, graphic injury, drugs and sexual content (blocked in Checkpoint 7: see `SAFEWATCH_MEDIA_ARCHITECTURE.md` §29.2), with a labelled evaluation set | PLANNED |
| 14 | Contextual AI | Scene-level understanding so context informs severity | PLANNED |
| 15 | Risk & Safety Report | Detection aggregation, safety score, content timeline | PLANNED |
| 16 | Pre-Playback Warning | Summary and report before watching (the timed in-playback warning exists since Checkpoint 9) | PLANNED |
| 17 | Filtering Engine | Beep, subtitle censoring, blur, rendered (edited) output and actions for further categories (mute and skip of flagged terms during playback exist since Checkpoint 8) | PLANNED |
| 18 | User Policies & Presets | Safety presets, custom policies, persistence, accounts as needed | PLANNED |
| 19 | Security + Performance | Hardening, rate limits, cost controls, load testing, observability | PARTIAL: Checkpoint 10 delivered sessions/ownership, Host/Origin checks, rate limits, disk quota, process isolation (macOS Seatbelt only) and lifecycle fixes. Still open: Linux/Windows sandbox, TLS, accounts, encryption at rest, CSP, shared rate limiting, load testing, observability, cost controls (`SAFEWATCH_MEDIA_ARCHITECTURE.md` §32.12) |
| 20 | Final Product Polish | UX refinement, empty/error states, accessibility audit, deployment | PLANNED |

## How the foundation supports this

- **Domain layer** gains `Media`, `AnalysisJob`, `Transcript`, `Detection`, `Policy` types as they become real (Checkpoints 1–6, 9).
- **Application layer** gains use cases behind ports; `MetadataReader` is the first (browser adapter today, server adapter in Checkpoint 1).
- **Infrastructure layer** gains the API client, FFmpeg/queue/AI-provider adapters.
- The backend (Node API + FFmpeg/FFprobe) was introduced in Checkpoint 2 as decided in `SAFEWATCH_MEDIA_ARCHITECTURE.md`. Audio/subtitle extraction moves to the next checkpoint so that Checkpoint 2 stayed a verified foundation. Later checkpoints are renumbered by one; Checkpoint 9 (complete product experience) was inserted after playback actions and shifted the rest again; Checkpoint 3 (extraction) was inserted before the first AI checkpoint, so everything after it moved by one again.

## Known gaps to decide in later checkpoints

Deployment target, database choice, AI providers and cost model, authentication, and where the filter engine runs (client player vs. pre-rendered output).
