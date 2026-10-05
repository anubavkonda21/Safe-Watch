# SafeWatch Roadmap

Each checkpoint is reviewed before the next is started. Scopes below are intent, to be refined from what each previous checkpoint actually discovers.

| # | Checkpoint | Intent | Status |
| --- | --- | --- | --- |
| 0A | Project Foundation | Stack, architecture, design system, landing page, local upload component, tests | DONE |
| 1 | Media Ingestion | Architecture decision (Node API + FFmpeg, phased), media domain model, ingestion state machine, `MediaProcessor` port, content-sniffing validation, browser metadata adapter | DONE |
| 2 | Speech + Subtitle Intelligence | **First:** Node/TS API, streamed upload, disk storage, `FfprobeMediaProcessor`, audio and subtitle extraction (needs FFmpeg installed). **Then:** speech-to-text, subtitle parsing, timestamped transcript | PLANNED |
| 3 | Custom Word/Phrase Detection | User word lists, matching with timestamps, profanity baseline | PLANNED |
| 4 | Visual Content Detection | Frame analysis for violence, graphic, drugs, sexual content with confidence | PLANNED |
| 5 | Contextual AI | Scene-level understanding so context informs severity | PLANNED |
| 6 | Risk & Safety Report | Detection aggregation, safety score, content timeline | PLANNED |
| 7 | Pre-Playback Warning | Summary and warnings before watching | PLANNED |
| 8 | Filtering Engine | Mute, beep, subtitle censoring, blur, scene skip | PLANNED |
| 9 | User Policies & Presets | Safety presets, custom policies, persistence, accounts as needed | PLANNED |
| 10 | Security + Performance | Hardening, rate limits, cost controls, load testing, observability | PLANNED |
| 11 | Final Product Polish | UX refinement, empty/error states, accessibility audit, deployment | PLANNED |

## How the foundation supports this

- **Domain layer** gains `Media`, `AnalysisJob`, `Transcript`, `Detection`, `Policy` types as they become real (Checkpoints 1–6, 9).
- **Application layer** gains use cases behind ports; `MetadataReader` is the first (browser adapter today, server adapter in Checkpoint 1).
- **Infrastructure layer** gains the API client, FFmpeg/queue/AI-provider adapters.
- A backend is introduced at the start of Checkpoint 2, when audio/subtitle extraction first requires FFmpeg (decision recorded in `SAFEWATCH_MEDIA_ARCHITECTURE.md`). Checkpoint 1 deliberately built only the contract.

## Known gaps to decide in later checkpoints

Deployment target, database choice, AI providers and cost model, authentication, and where the filter engine runs (client player vs. pre-rendered output).
