import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for a defect only a real narrow browser showed (jsdom has no layout): at 320 px a full-width button made the
 * playback section 291 px wide, so the whole page overflowed by 11 px. The fix is that these grids may shrink below their widest
 * child. This test only checks the rules are still there; the real check is the responsive QA in the checkpoint report.
 */
// Vitest runs from the repository root (the web project has no file URLs).
const css = readFileSync(join(process.cwd(), 'src/features/upload/upload.css'), 'utf8');

describe('narrow-screen layout rules', () => {
  it.each(['.sw-playback', '.sw-feedback', '.sw-feedback__list', '.sw-guide'])('%s is a shrinkable grid column', (selector) => {
    const rule = css.split('}').find((r) => r.includes(selector) && r.includes('minmax(0, 1fr)'));
    expect(rule, `${selector} must have grid-template-columns: minmax(0, 1fr)`).toBeTruthy();
  });
  it('the warning slot reserves its height so a warning never moves the controls (taller on phones where the buttons stack)', () => {
    expect(css).toMatch(/\.sw-warnslot\s*\{[^}]*min-height:\s*92px/);
    expect(css).toMatch(/@media \(max-width: 479px\)\s*\{\s*\.sw-warnslot\s*\{\s*min-height:\s*148px/);
  });
  it('the warning animations are switched off for people who ask for reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*\.sw-warn\s*\{\s*animation:\s*none/);
    expect(css).toMatch(/\.sw-warn__bar\s*\{\s*display:\s*none/);
  });
});
