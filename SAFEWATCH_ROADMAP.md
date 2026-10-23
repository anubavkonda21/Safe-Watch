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
| 8 | Custom Word/Phrase Detection | Builds on the Checkpoint 4 foundation (models, matching, UI exist): server-side/persistent filter lists, profanity baseline lists, better handling of mixed-language and misheard terms | PLANNED |
| 9 | Visual Content Detection | Needs a genuine local visual or multimodal classifier for violence, graphic injury, drugs and sexual content (blocked in Checkpoint 7: see `SAFEWATCH_MEDIA_ARCHITECTURE.md` §29.2), with a labelled evaluation set | PLANNED |
| 10 | Contextual AI | Scene-level understanding so context informs severity | PLANNED |
| 11 | Risk & Safety Report | Detection aggregation, safety score, content timeline | PLANNED |
| 12 | Pre-Playback Warning | Summary and warnings before watching | PLANNED |
| 13 | Filtering Engine | Mute, beep, subtitle censoring, blur, scene skip | PLANNED |
| 14 | User Policies & Presets | Safety presets, custom policies, persistence, accounts as needed | PLANNED |
| 15 | Security + Performance | Hardening, rate limits, cost controls, load testing, observability | PLANNED |
| 16 | Final Product Polish | UX refinement, empty/error states, accessibility audit, deployment | PLANNED |

## How the foundation supports this

- **Domain layer** gains `Media`, `AnalysisJob`, `Transcript`, `Detection`, `Policy` types as they become real (Checkpoints 1–6, 9).
- **Application layer** gains use cases behind ports; `MetadataReader` is the first (browser adapter today, server adapter in Checkpoint 1).
- **Infrastructure layer** gains the API client, FFmpeg/queue/AI-provider adapters.
- The backend (Node API + FFmpeg/FFprobe) was introduced in Checkpoint 2 as decided in `SAFEWATCH_MEDIA_ARCHITECTURE.md`. Audio/subtitle extraction moves to the next checkpoint so that Checkpoint 2 stayed a verified foundation. Later checkpoints are renumbered by one; Checkpoint 3 (extraction) was inserted before the first AI checkpoint, so everything after it moved by one again.

## Known gaps to decide in later checkpoints

Deployment target, database choice, AI providers and cost model, authentication, and where the filter engine runs (client player vs. pre-rendered output).
