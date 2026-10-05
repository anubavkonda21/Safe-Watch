# Checkpoint 0A Report — SafeWatch Project Foundation

Context: the working directory was empty and not a Git repository, so this checkpoint initialised the project from scratch. No existing implementation was assumed.

## 1. Environment

| Item | Value |
| --- | --- |
| OS | macOS 27.0.1 (Darwin 27.0.0) |
| Node.js | v24.21.0 |
| Package manager | npm 11.19.0 (pnpm, yarn not installed) |
| Git | 2.54.0 |
| FFmpeg | **Not installed** (not needed until Checkpoint 1) |
| Python | 3.14.6 (not used) |
| Docker | Not installed (not used) |

## 2. Technology Decisions

| Area | Selected | Why | Alternatives considered |
| --- | --- | --- | --- |
| Build/dev | Vite 8 | Fast, minimal config, first-class TypeScript/React | Next.js (SSR/server not needed yet; adds weight and couples backend choice), CRA (unmaintained) |
| UI | React 19 + TypeScript (strict, `noUncheckedIndexedAccess`) | Required modern React + strong typing; ecosystem for video/player work | Svelte/Vue (not requested) |
| Routing | React Router 7 | Standard, small | TanStack Router (more than needed) |
| Styling | Plain CSS + design tokens (CSS custom properties) | Tokens map 1:1 to the design spec; zero runtime; no framework look | Tailwind (utility sprawl makes token discipline harder to enforce), CSS-in-JS (runtime cost) |
| Components | Own small library | Spec demands bespoke look; ~12 components | Radix/shadcn (can be adopted later for complex widgets, e.g. menus) |
| Tests | Vitest + Testing Library + jsdom | Shares Vite config, fast, tests real behavior | Jest (extra config), Playwright (planned for end-to-end later) |
| Lint | ESLint 9 + typescript-eslint + react-hooks + jsx-a11y | Accessibility enforced at lint time | ESLint 10 (blocked by jsx-a11y peer range) |
| Backend | **None yet** | Nothing requires one; decided at Checkpoint 1 when FFmpeg/storage/AI need a server. Leading candidate: Node + TypeScript API sharing `domain/` types | Building a speculative backend now (over-engineering) |

## 3. Architecture

Current:

```
┌───────────────────────── Browser (SPA) ─────────────────────────┐
│ PRESENTATION   app/ pages/ components/{ui,layout,marketing}      │
│                features/upload                                   │
│        │ calls                                                   │
│ APPLICATION    application/ingestMedia  (port: MetadataReader)   │
│        │ uses                                                    │
│ DOMAIN         domain/media/upload  (validation, sanitising,     │
│                formatting — pure, no browser APIs)               │
│        ▲ implements ports                                        │
│ INFRASTRUCTURE infrastructure/browserMetadataReader, config/env  │
└──────────────────────────────────────────────────────────────────┘
        (no network, no backend, no AI in this checkpoint)
```

Target (not built), each plugging in at the existing boundaries:

```
Frontend → API → Media Service ─┐
                 Analysis Svc   ├─ Domain types shared
                 Detection Svc  │  Infrastructure adapters: FFmpeg,
                 Policy Svc     │  queue, storage, AI providers
                 Filtering Svc ─┘
```

## 4. Repository Structure

| Path | Purpose |
| --- | --- |
| `src/app/` | App root and routes |
| `src/pages/` | Route-level screens (`HomePage`, `NotFoundPage`) |
| `src/components/ui/` | Design-system primitives |
| `src/components/layout/` | Navigation, footer, wordmark |
| `src/components/marketing/` | Landing sections and hero illustration |
| `src/features/upload/` | Upload dropzone (UI + styles + tests) |
| `src/domain/` | Pure business rules and types |
| `src/application/` | Use cases and ports |
| `src/infrastructure/` | Adapters: config validation, browser metadata reader |
| `src/lib/` | Tiny shared helpers (`cn`) |
| `src/styles/` | Tokens, base, UI, layout, marketing CSS |
| `src/test/` | Test setup |
| `src/hooks/` | Intentionally not created: no shared hooks exist yet |
| `public/` | Static assets (favicon) |

The spec's example had `services/`, `types/`, `assets/` and `hooks/`; they are omitted until there is something to put in them. `services/` is replaced by `application/` + `infrastructure/`, and types live with the domain they describe.

## 5. Design System

Summarised from `SAFEWATCH_DESIGN_SYSTEM.md`: dark-first layered surfaces `#05070A → #080C11 → #0D1218 → #111821`; borders `#1D2630`/`#2A3542`; accent `#7C6CFF` used sparingly; Inter with the specified scale; 4–96px spacing scale; radii 8/10/14/18; max width 1280px, gutters 32/24/16; motion 140/200/340ms, opacity/transform only.

Deviation from the supplied palette: `#697586` (muted) measures 4.0–4.3:1, below AA for small text, so it is reserved for placeholders, disabled and hover borders; readable secondary text uses `#A1AAB6`. I added `--sw-surface-hover` (`#151E29`) and `--sw-on-accent` (`#0B0A1A`) because hover and text-on-accent needed defined values.

## 6. Implemented UI

Screens: Home (`/`), 404. Home sections: navigation, hero with illustrative analysis visual, capability cards (Understand / Detect / Control), upload section, How it works, Safety, About, footer.
Components: Button, ButtonLink, IconButton, Input, Select, Card, Badge, Alert, Modal, Progress, Divider, Tooltip, Container, Navigation, Wordmark, Footer, UploadDropzone, AnalysisVisual.
Note: Modal, Input, Select and Tooltip are built and tested but not yet used on any screen.

## 7. Responsive Behavior

- ≥1024px: hero is two columns (11fr/9fr ≈ 55/45); full nav.
- 768–1023px: hero stacks (text, then visual capped at 640px); gutters 24px; steps 2-up.
- <768px: nav collapses to a menu button (`aria-expanded`); hero CTAs full-width; features and steps single column; upload button full-width; display type 34px.
- Verified visually at desktop and 375px; no horizontal overflow at 375px. Not tested on real devices, and 320px and tablet widths were not individually inspected.

## 8. Accessibility

Landmarks and skip link; one `h1`; visible `:focus-visible` ring; 44px touch targets; labelled form controls with `aria-describedby`/`aria-invalid`; live region for upload status; `role="alert"` for errors; native `<dialog>`; decorative SVG `aria-hidden`; icon buttons require labels; global `prefers-reduced-motion`; `jsx-a11y` lint. Not done: manual screen-reader testing, automated axe audit.

## 9. Testing

`npm test`: **5 files, 41 tests, 41 passed, 0 failed, 0 skipped** (~0.7s). Coverage: app boot/landmarks/nav/404/mobile menu; every ui component's behavior (disabled, loading, keyboard, aria wiring, modal open/close); upload states (default, drag-over, processing, success, error: type/size/unreadable, drop); domain validation, filename sanitising (traversal, bidi, metacharacters, length), formatters; config validation.
`npm run lint`: clean. `npm run typecheck`: clean.

## 10. Build

`npm run build` succeeds (tsc + vite, ~0.1–0.2s): `index.html` 1.01 kB; CSS 17.6 kB (4.4 kB gzip); JS 276.8 kB (87.7 kB gzip). `npm audit`: 0 vulnerabilities.

## 11. Security

Implemented: `.env` ignored, `.env.example` provided; config validated at startup and fails loudly; only `VITE_` public values; no secrets in repo; upload validation by extension allowlist + MIME check + empty/size limit (default 2 GB, configurable); filename sanitising (path segments, control/bidi chars, metacharacters, length) before display; no use of user input in commands (no commands exist); files are read only via browser object URLs, never uploaded, and URLs are revoked.
Not implemented (future): content sniffing of file bytes, server-side validation, auth, rate limiting, CSP headers, FFmpeg hardening, prompt-injection and malicious-subtitle handling. Client-side validation is a convenience, not a security boundary.

## 12. Known Limitations

- No backend, no real upload, no AI, no analysis: the upload component only validates and reads local metadata.
- MKV/AVI metadata is often unreadable in browsers; duration then shows as unknown (after a 4s timeout).
- The 2 GB default limit is a client-side setting only.
- Inter loads from Google Fonts (third-party request); self-hosting is advisable before production for privacy and performance.
- Hero visual is illustrative, labelled as such.
- Nav links are in-page anchors; no active-section indication.
- Not deployed; no CI; no end-to-end or visual-regression tests.
- Dependencies are recent major versions (e.g. TypeScript 6, Vite 8, ESLint pinned to 9 for jsx-a11y).

## 13. Future Architecture

`MetadataReader` shows the intended pattern: the application depends on a port, and Checkpoint 1 supplies a server adapter without touching UI or domain rules. New domain types (Media, AnalysisJob, Transcript, Detection, Policy) go in `domain/`; each pipeline stage becomes a use case in `application/` with adapters (FFmpeg, queue, storage, AI provider) in `infrastructure/`. Validation rules in `domain/` are framework-free so a Node server can reuse them. See `SAFEWATCH_ROADMAP.md`.

## 14. Git

- Branch: `main`
- Commit: `feat: initialize SafeWatch product foundation` (hash reported in the final message; a commit cannot contain its own hash)
- Remote: **none configured** — it must be added manually (`git remote add origin <url>` then `git push -u origin main`). No URL or credentials were invented.
- Push: not performed (no remote)
- Working tree: clean after the commit
