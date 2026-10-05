# SafeWatch Design System

Single source of truth for all UI. Tokens live in `src/styles/tokens.css`; components in `src/components/ui`. If a design need is not covered here, extend this document and the tokens first, then build.

## 1. Philosophy

Premium AI product, security-grade trust, Apple-level simplicity, Linear-level precision. Sophisticated, not flashy.

- Quality comes from hierarchy, typography, spacing, alignment and consistency, not effects.
- Dark-first, predominantly neutral. Depth through tonal layers, not shadows.
- The accent is rare; it marks the one thing that matters on a screen.
- Honesty: UI never implies a capability that does not exist (use `Planned` / `Early preview` badges).
- Avoid: generic SaaS templates, heavy gradients, glassmorphism, oversized radii, glow, emoji as icons, cybersecurity clichés (padlocks, hacker imagery, Matrix rain), decorative motion.

## 2. Color

| Token | Hex | Purpose |
| --- | --- | --- |
| `--sw-bg` | `#05070A` | Page background |
| `--sw-bg-2` | `#080C11` | Secondary background, inputs, recessed areas |
| `--sw-surface` | `#0D1218` | Cards, panels |
| `--sw-surface-2` | `#111821` | Elevated: modals, popovers, icon tiles |
| `--sw-surface-hover` | `#151E29` | Hover state of a surface |
| `--sw-border` | `#1D2630` | Default border / divider |
| `--sw-border-hover` | `#2A3542` | Hover and stronger borders; control outlines |
| `--sw-text` | `#F5F7FA` | Primary text |
| `--sw-text-2` | `#A1AAB6` | Secondary text, captions, hints |
| `--sw-text-muted` | `#697586` | Non-essential only: placeholders, disabled, hover borders |
| `--sw-accent` | `#7C6CFF` | Primary action, selection, active navigation, analysis progress |
| `--sw-accent-hover` | `#9184FF` | Accent hover, eyebrow text, focus ring |
| `--sw-on-accent` | `#0B0A1A` | Text on accent fills |
| `--sw-success` | `#22C55E` | Completed, safe, confirmed |
| `--sw-warning` | `#F59E0B` | Caution, moderate-risk moments |
| `--sw-danger` | `#EF4444` | Errors, destructive actions, high-risk moments |
| `--sw-info` | `#38BDF8` | Neutral information, speech signals |

Each semantic color has a `*-subtle` 12%-alpha variant for badge/alert backgrounds.

**Contrast (computed, WCAG):** text 18.8:1, text-2 8.6:1 on `bg` (8.0:1 on `surface`), on-accent on accent 5.1:1, accent-hover on bg 6.7:1, semantic colors 5.4–9.4:1 on bg. **`--sw-text-muted` is 4.3:1 on `bg` and 4.0:1 on `surface`, below the 4.5:1 AA minimum for small text: never use it for information a user must read.** Placeholder text currently uses it (known limitation). Borders (`--sw-border-hover` 1.6:1) are decorative; control boundaries must be identifiable by more than a border where they are the only affordance.

Rules: never use color alone to convey meaning; pair with text or icon. Do not introduce new hex values in components.

## 3. Typography

Family: `Inter`, fallback `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Mono: `ui-monospace, "SF Mono", Menlo, Consolas`. Loaded from Google Fonts (400–700); falls back gracefully if unavailable.

| Role | Class | Size | Weight | Line height | Tracking |
| --- | --- | --- | --- | --- | --- |
| Display | `.sw-display` | 48 / 40 tablet / 34 mobile | 700 | 1.08 | −0.03em |
| H1 | `.sw-h1` | 36 (30 mobile) | 700 | 1.15 | −0.025em |
| H2 | `.sw-h2` | 28 (24 mobile) | 650 | 1.2 | −0.02em |
| H3 | `.sw-h3` | 20 | 600 | 1.3 | −0.01em |
| Body large | `.sw-body-lg` | 18 | 400 | 1.6 | 0 |
| Body | `.sw-body` | 16 | 400 | 1.6 | 0 |
| Body small | `.sw-body-sm` | 14 | 400 | 1.55 | 0 |
| Caption | `.sw-caption` | 12 | 500 | 1.4 | 0 |
| Label | `.sw-label` | 12 uppercase | 600 | 1.3 | 0.04em |

Use heading classes for visual size independent of heading level; keep one `h1` per page and a logical outline.

## 4. Spacing

4px base; allowed values only: `4 8 12 16 20 24 32 40 48 64 80 96` (`--sw-s-1 … --sw-s-24`). Section vertical padding: 80px desktop, 64px tablet, 48px mobile. Hero: 96px top on desktop.

## 5. Grid, layout, breakpoints

- Content max width 1280px, centered (`Container`).
- Page gutter: 32px desktop, 24px tablet, 16px mobile.
- 12-column grid, 24px gap.
- Navigation 72px tall (64px mobile), sticky.

| Name | Range | Behavior |
| --- | --- | --- |
| Desktop | ≥1440px | Full layout |
| Laptop | 1024–1439px | Full layout, container centered |
| Tablet | 768–1023px | Hero stacks; steps 2-up; features stay 3-up until 767px |
| Mobile | 320–767px | Single column; nav collapses to menu; full-width actions |

Layout reflows; it never merely scales.

## 6. Radius, borders, shadows

| Element | Radius |
| --- | --- |
| Small controls, buttons | 8px |
| Inputs | 10px |
| Cards, alerts | 14px |
| Large containers (upload, visual) | 18px |
| Modal | 18px |

Borders are 1px, `--sw-border` by default, `--sw-border-hover` on hover. Upload zone uses 1px dashed.
Shadows: only for floating layers (popover `0 8px 24px rgb(0 0 0/.4)`, modal `0 24px 64px rgb(0 0 0/.55)`). Static surfaces use tonal contrast, no shadow, no glow.

## 7. Components

All live in `src/components/ui`. Never restyle per page.

- **Button** — `primary` (accent; one per view region), `secondary`, `ghost`; sizes `md` (44px min height) and `lg` (52px). States: hover, active (scale .98), focus-visible ring, disabled (50%), loading (spinner, disabled, `aria-busy`). `ButtonLink` for navigation.
- **IconButton** — 44×44, `label` prop mandatory (accessible name).
- **Input / Select** — always labelled; optional hint; `error` sets `aria-invalid` and links message via `aria-describedby`. Min height 44px, 16px text (prevents iOS zoom).
- **Card** — surface, 14px radius, 24px padding; `hoverable` only when the card is not itself a control.
- **Badge** — uppercase 12px; tones neutral/accent/success/warning/danger/info. Used for status (`Planned`, `Early preview`).
- **Alert** — tone icon + title + body; `danger`/`warning` use `role="alert"`, others `role="status"`.
- **Progress** — 4px bar, determinate or indeterminate; accent fill; labelled.
- **Divider**, **Container**.
- **Tooltip** — hover and focus; supplementary info only, never essential content.
- **Modal** — native `<dialog>` (focus trap, Escape, inert background); 18px radius; closes via button, Escape or backdrop.
- **Navigation** — lightweight 72px bar; text links + one primary CTA; collapses to a disclosure menu below 768px with `aria-expanded`.

## 8. Icons

Inline SVG, 24px grid, 1.6px stroke, `currentColor`, `aria-hidden` when decorative (`components/ui/icons.tsx`). No emoji as UI icons. Wordmark: shield outline containing a play triangle (protection + media), "Safe" in primary text and "Watch" in secondary.

## 9. States

- **Loading:** indeterminate `Progress` or button spinner; say what is happening ("Reading video").
- **Empty:** one heading, one line of guidance, one primary action (upload zone is the model).
- **Error:** `Alert tone="danger"` with what failed and what to do next; never expose raw error text. Keep the user's context and offer retry.
- **Success:** confirm what happened and what is (not) available next.
- **Upload zone states:** default (neutral surface; hover lifts to `surface-2`), drag-over (solid accent border, subtle accent tint), validating and processing (indeterminate progress, `aria-busy`), ready (success-tinted border and check), error (danger border, Alert with what/why/fix), disabled (60% opacity, control disabled). Dimensions: max 680px, min-height 280px, 32px padding, 18px radius; on mobile full width, 240px, 24px padding.
- **Valid but unreadable:** when a file is valid but details cannot be read locally, show an info Alert, never an error.

## 10. Motion

| Use | Duration | Token |
| --- | --- | --- |
| Hover, press, focus | 140ms | `--sw-t-fast` |
| Standard transitions | 200ms | `--sw-t-normal` |
| Modal / large | 340ms | `--sw-t-slow` |

Easing `cubic-bezier(0.2, 0, 0, 1)`. Animate only opacity, transform and border/background color. No bounce, no ambient motion except the single slow scan line in the hero illustration. Analysis results must never compete with motion. `prefers-reduced-motion` collapses all animation (global rule in `base.css`).

## 11. Accessibility

- Semantic landmarks (`header`, `nav`, `main`, `footer`), skip link, one `h1`, labelled sections.
- Visible 2px focus ring (`:focus-visible`, accent-hover) on every interactive element.
- Minimum 44px touch targets for controls.
- Forms: visible labels, error association, `aria-invalid`.
- Live regions announce upload progress, success and failure.
- Color is never the only signal.
- Contrast figures in §2; `jsx-a11y` lint enforced.

## 12. Responsive behavior

Hero: two columns (55/45) ≥1024px, stacked below. Features: 3 → 1 column at 767px. Steps: 4 → 2 → 1. Navigation collapses at 767px. Upload zone is fluid up to 680px and its button goes full-width on mobile. No horizontal scrolling at 320px.
