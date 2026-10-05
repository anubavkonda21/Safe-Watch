# SafeWatch

> Understand your media. Control your experience.

SafeWatch is intended to become a premium AI-powered media-safety platform: it understands what is happening inside a video and gives users control over what they are willing to see and hear.

## Current status

**Checkpoint 0A — project foundation.** The interface, architecture and tooling exist. There is **no analysis engine, no backend and no AI**.

| Capability | Status |
| --- | --- |
| Landing page (nav, hero, capabilities, how it works) | IMPLEMENTED |
| Design system tokens + foundational components | IMPLEMENTED |
| Upload component (select/drop, validate, read local metadata) | IMPLEMENTED — local only, nothing is uploaded |
| Responsive layout, accessibility foundation | IMPLEMENTED |
| Tests, lint, typecheck, build | IMPLEMENTED |
| Media ingestion (server, storage, FFmpeg) | PLANNED |
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
