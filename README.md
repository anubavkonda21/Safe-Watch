# SafeWatch

> Understand your media. Control your experience.

SafeWatch is intended to become a premium AI-powered media-safety platform: it understands what is happening inside a video and gives users control over what they are willing to see and hear.

## Current status

**Checkpoint 0A — project foundation.** The interface, architecture and tooling exist. There is **no analysis engine, no backend and no AI**.

| Capability | Status |
| --- | --- |
| Landing page (nav, hero, capabilities, how it works) | IMPLEMENTED |
| Design system tokens + foundational components | IMPLEMENTED |
| Media ingestion foundation: `MediaAsset` model, state machine, typed errors, `MediaProcessor` port | IMPLEMENTED |
| Upload component (select/drop, content-sniff validation, local metadata) | IMPLEMENTED — local only, nothing is uploaded |
| Server, FFmpeg/FFprobe, streamed upload, storage | PLANNED (Checkpoint 2) |
| Responsive layout, accessibility foundation | IMPLEMENTED |
| Tests, lint, typecheck, build | IMPLEMENTED |
| Speech-to-text, subtitle analysis | PLANNED |
| Profanity / custom phrase detection | PLANNED |
| Visual detection (violence, graphic, drugs, sexual content) | PLANNED |
| Contextual analysis, risk score, timeline | PLANNED |
| Pre-playback warnings | PLANNED |
| Filtering (mute, beep, subtitle censoring, blur, skip) | PLANNED |
| Safety presets and custom user policies | PLANNED |
| Authentication, database, background jobs | PLANNED |

## Architecture

Layers depend inward only: `components/features → application → domain`, with `infrastructure` implementing ports declared by `application`.

```
Presentation   components/, features/, pages/, app/
      ↓
Application    application/      use cases + ports (e.g. ingestMedia, MetadataReader)
      ↓
Domain         domain/           pure rules and types (no framework, no browser APIs)
      ↑
Infrastructure infrastructure/   adapters: config, browser metadata reader
```

See `CHECKPOINT_0A_REPORT.md` for the full diagram and rationale, and `SAFEWATCH_ROADMAP.md` for where each future service plugs in.

## Media architecture

Decision (see `SAFEWATCH_MEDIA_ARCHITECTURE.md`): a Vite SPA plus a **Node/TypeScript API that runs FFmpeg/FFprobe**, introduced in Checkpoint 2. Browser-only processing cannot extract subtitles/audio reliably and cannot hold AI keys; a separate media service or managed cloud is unjustified at this stage. Only the client-side contract exists today.

```
File → validate (extension + MIME + size + filename) → sniff first 64 bytes (must match extension)
     → MediaAsset(accepted) → MediaProcessor.extractMetadata → MediaAsset(ready)
```

- `src/domain/media` — `MediaAsset`, `MediaMetadata`, ingestion state machine (`idle → validating → accepted → processing → ready | failed`), typed `MediaIngestionError` codes, validation, container detection.
- `src/application` — `MediaProcessor` port and `createMediaIngestion` service.
- `src/infrastructure` — `browserMediaProcessor` (duration/dimensions via `<video>`; unreadable metadata is reported as *unavailable*, never as an invalid file).
- Large files are never loaded into memory: only the first 64 bytes are read, and metadata comes from a streamed object URL.

## Technology stack

- **Vite + React 19 + TypeScript (strict)** — SPA with fast tooling.
- **React Router** — routing.
- **Plain CSS with design tokens** — no UI framework; tokens in `src/styles/tokens.css`.
- **Vitest + Testing Library** — component and unit tests.
- **ESLint (typescript-eslint, react-hooks, jsx-a11y)**.

## Development setup

Requires Node.js 20+ (developed on 24) and npm.

```bash
npm install
cp .env.example .env   # optional; defaults are valid
npm run dev
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server at http://localhost:5173 |
| `npm run build` | Typecheck and production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run tests once (`test:watch` for watch mode) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript only |

FFmpeg is not needed yet; it will be required from Checkpoint 1.

## Design system

`SAFEWATCH_DESIGN_SYSTEM.md` is the single source of truth for UI. Use the tokens in `src/styles/tokens.css`; never hard-code colors, spacing or radii in pages.

## Roadmap

See `SAFEWATCH_ROADMAP.md` (Checkpoints 0A → 11).

## Development workflow

- One checkpoint at a time; each is reviewed before the next begins.
- Before committing: `npm test && npm run lint && npm run typecheck && npm run build`.
- Never commit secrets. `.env` is git-ignored; document new variables in `.env.example` and validate them in `src/infrastructure/config/env.ts`. Variables prefixed `VITE_` are public — they ship to the browser.
- Reusable UI goes in `src/components/ui`; do not restyle it per page.
