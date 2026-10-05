# SafeWatch

> Understand your media. Control your experience.

SafeWatch is intended to become a premium AI-powered media-safety platform: it understands what is happening inside a video and gives users control over what they are willing to see and hear.

## Current status

**Checkpoint 2 — server media foundation.** The interface, a Node API, secure upload, temporary storage and FFprobe/FFmpeg processing exist. There is **no analysis and no AI**: a video can be `Media: ready` while `Analysis: not started`.

| Capability | Status |
| --- | --- |
| Landing page (nav, hero, capabilities, how it works) | IMPLEMENTED |
| Design system tokens + foundational components | IMPLEMENTED |
| Media ingestion foundation: `MediaAsset` model, state machine, typed errors, `MediaProcessor` port | IMPLEMENTED |
| Upload component (select/drop, content-sniff validation, local metadata) | IMPLEMENTED — local only, nothing is uploaded |
| Node API: health, streamed upload, status, delete | IMPLEMENTED |
| Server validation (extension, MIME, signature, size, FFprobe structure) | IMPLEMENTED |
| Temporary disk storage with lifecycle and cleanup | IMPLEMENTED |
| FFprobe metadata + FFmpeg decode check | IMPLEMENTED |
| Real upload progress in the UI | IMPLEMENTED |
| Audio / subtitle / frame extraction | PLANNED |
| Persistent database, authentication, background workers | PLANNED |
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

Decision (see `SAFEWATCH_MEDIA_ARCHITECTURE.md`): a Vite SPA plus a **Node/TypeScript API that runs FFmpeg/FFprobe**, in the same repository, sharing the pure domain code in `src/domain`.

```
Browser ──raw file stream (XHR, real progress)──► Node API ──► MediaService ──► MediaStorage (disk)
   ▲                                                  │                              │
   └──────────── poll GET /api/media/:id ◄────────────┘             FfmpegMediaProcessor → ffprobe / ffmpeg
```

- `src/domain` – shared: `MediaAsset`, validation, container sniffing, ingestion state machine, API contract, analysis boundary.
- `src/application`, `src/infrastructure` – browser side: ingestion service, `MediaUploader` port, `HttpMediaUploader`.
- `server/src/api` – HTTP only (routing, CORS, error rendering). No media logic.
- `server/src/application` – `MediaService`, ports (`MediaStorage`, `ServerMediaProcessor`, `Logger`), processing queue.
- `server/src/domain` – server-side media record and state transitions.
- `server/src/infrastructure` – local-disk storage, FFmpeg adapter, in-memory registry, JSON logger.

Media status (`uploaded → processing → ready | failed`) is separate from analysis status (`not_started → queued → processing → completed | failed`).

## Backend setup

Requires **FFmpeg and FFprobe** on `PATH` (or `SAFEWATCH_FFMPEG_PATH` / `SAFEWATCH_FFPROBE_PATH`).

```bash
brew install ffmpeg          # macOS (Homebrew)
# sudo apt install ffmpeg    # Debian/Ubuntu
ffmpeg -version && ffprobe -version
```

Run the two processes in two terminals:

```bash
npm run dev:server   # API on http://127.0.0.1:8787
npm run dev          # SPA on http://localhost:5173 (proxies /api to the API)
```

The server refuses to start (with instructions) if FFmpeg/FFprobe are missing. Without a server you can still use the UI with `VITE_MEDIA_BACKEND=browser`. Production build of the API: `npm run build:server && npm start`. All variables are documented in `.env.example`.

## Upload API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | `{status, service, version, environment, tools}`; no paths or secrets |
| `POST /api/media` | Raw file body; header `X-SafeWatch-Filename` (URI-encoded) and `Content-Type`. Returns **202** `{media:{asset, analysis}}` with `Location`. The body is streamed to disk, never buffered |
| `GET /api/media/:id` | Current `{asset, analysis}`; poll until `asset.status` is `ready` or `failed` |
| `DELETE /api/media/:id` | Delete the stored file and record (idempotent, 204) |

Errors are `{error:{code, message, requestId}}` with codes `INVALID_FILE`, `UNSUPPORTED_MEDIA`, `FILE_TOO_LARGE`, `UPLOAD_FAILED`, `MEDIA_PROCESSING_FAILED`, `MEDIA_METADATA_FAILED`, `STORAGE_FAILED`, `PROCESSING_TIMEOUT`, `SERVER_BUSY`, `NOT_FOUND`, `INTERNAL_ERROR`.

## Media and storage lifecycle

Upload → `<uuid>.part` on disk → renamed to `<uuid>.media` when complete (`uploaded`) → queued/`processing` (FFprobe + decode check) → `ready` (file kept) or `failed` (file deleted immediately). Ready media is deleted when the user replaces it (`DELETE`), or automatically after `SAFEWATCH_RETENTION_MINUTES` (default 60). Orphaned files are swept by age; the whole storage directory is purged at startup and shutdown. See `SAFEWATCH_MEDIA_ARCHITECTURE.md` for the production FFmpeg strategy.

## Technology stack

- **Vite + React 19 + TypeScript (strict)** — SPA with fast tooling.
- **Node 24 (no web framework)** — the API uses `node:http`; **FFmpeg/FFprobe** as external processes; **tsx** to run TypeScript in development.
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
| `npm run dev` | Frontend dev server at http://localhost:5173 |
| `npm run dev:server` | API dev server at http://127.0.0.1:8787 (restarts on change) |
| `npm run build:server` / `npm start` | Bundle and run the API (`dist-server/`) |
| `npm run check:large -- <file>` | Manual large-file streaming/memory check |
| `npm run build` | Typecheck and production build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run tests once (`test:watch` for watch mode) |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript only |


## Design system

`SAFEWATCH_DESIGN_SYSTEM.md` is the single source of truth for UI. Use the tokens in `src/styles/tokens.css`; never hard-code colors, spacing or radii in pages.

## Roadmap

See `SAFEWATCH_ROADMAP.md` (Checkpoints 0A → 11).

## Development workflow

- One checkpoint at a time; each is reviewed before the next begins.
- Before committing: `npm test && npm run lint && npm run typecheck && npm run build`.
- Never commit secrets. `.env` is git-ignored; document new variables in `.env.example` and validate them in `src/infrastructure/config/env.ts`. Variables prefixed `VITE_` are public — they ship to the browser.
- Reusable UI goes in `src/components/ui`; do not restyle it per page.
