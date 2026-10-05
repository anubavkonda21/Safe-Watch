# SafeWatch Roadmap

Each checkpoint is reviewed before the next is started. Scopes below are intent, to be refined from what each previous checkpoint actually discovers.

| # | Checkpoint | Intent | Status |
| --- | --- | --- | --- |
| 0A | Project Foundation | Stack, architecture, design system, landing page, local upload component, tests | DONE |
| 1 | Media Ingestion | Architecture decision (Node API + FFmpeg, phased), media domain model, ingestion state machine, `MediaProcessor` port, content-sniffing validation, browser metadata adapter | DONE |
| 2 | Server Media Foundation | Node API, streamed upload, temporary storage lifecycle, FFprobe metadata, FFmpeg decode check, `AnalysisJob` boundary, upload progress UI | DONE |
| 3 | Media Extraction + Speech/Subtitle Intelligence | Audio and subtitle extraction, then speech-to-text, subtitle parsing, timestamped transcript | PLANNED |
| 4 | Custom Word/Phrase Detection | User word lists, matching with timestamps, profanity baseline | PLANNED |
| 5 | Visual Content Detection | Frame analysis for violence, graphic, drugs, sexual content with confidence | PLANNED |
| 6 | Contextual AI | Scene-level understanding so context informs severity | PLANNED |
| 7 | Risk & Safety Report | Detection aggregation, safety score, content timeline | PLANNED |
| 8 | Pre-Playback Warning | Summary and warnings before watching | PLANNED |
| 9 | Filtering Engine | Mute, beep, subtitle censoring, blur, scene skip | PLANNED |
| 10 | User Policies & Presets | Safety presets, custom policies, persistence, accounts as needed | PLANNED |
| 11 | Security + Performance | Hardening, rate limits, cost controls, load testing, observability | PLANNED |
| 12 | Final Product Polish | UX refinement, empty/error states, accessibility audit, deployment | PLANNED |

## How the foundation supports this

- **Domain layer** gains `Media`, `AnalysisJob`, `Transcript`, `Detection`, `Policy` types as they become real (Checkpoints 1–6, 9).
- **Application layer** gains use cases behind ports; `MetadataReader` is the first (browser adapter today, server adapter in Checkpoint 1).
- **Infrastructure layer** gains the API client, FFmpeg/queue/AI-provider adapters.
- The backend (Node API + FFmpeg/FFprobe) was introduced in Checkpoint 2 as decided in `SAFEWATCH_MEDIA_ARCHITECTURE.md`. Audio/subtitle extraction moves to the next checkpoint so that Checkpoint 2 stayed a verified foundation. Later checkpoints are renumbered by one.

## Known gaps to decide in later checkpoints

Deployment target, database choice, AI providers and cost model, authentication, and where the filter engine runs (client player vs. pre-rendered output).
