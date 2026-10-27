import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * jsdom lays nothing out, so target sizes are guarded where they are defined: in the stylesheets. The sizes themselves were
 * measured in a real browser at 320, 375, 768 and 1280 px (see CHECKPOINT_12_REPORT.md). 44 px is `--sw-touch`.
 */
const css = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''); // comments removed so they cannot be read as selectors
const ui = css('src/styles/ui.css');
const layout = css('src/styles/layout.css');
const upload = css('src/features/upload/upload.css');
const youtube = css('src/features/youtube/youtube.css');
const tokens = css('src/styles/tokens.css');

/** The declaration block of the first rule whose selector list contains `selector` exactly. */
function rule(source: string, selector: string): string {
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(',').map((x) => x.trim()).includes(selector)) return m[2]!;
  }
  throw new Error(`no rule for ${selector}`);
}

describe('touch targets', () => {
  it('the shared size is 44 px', () => { expect(tokens).toMatch(/--sw-touch:\s*44px/); });

  it.each([
    ['buttons', ui, '.sw-btn'],
    ['inputs', ui, '.sw-input'],
    ['selects (all of them, including the playback and preference selects)', ui, '.sw-select'],
    ['navigation links', layout, '.sw-nav__link'],
    ['the logo link', layout, '.sw-wordmark'],
    ['disclosure summaries', upload, '.sw-details > summary'],
    ['the automatic-actions switch label', upload, '.sw-pswitch'],
    ['source tabs', youtube, '.sw-source__tab'],
  ])('%s are at least var(--sw-touch) tall', (_name, source, selector) => {
    expect(rule(source, selector)).toMatch(/min-height:\s*(var\(--sw-touch\)|44px)/);
  });

  it('icon buttons are var(--sw-touch) square', () => {
    const r = rule(ui, '.sw-icon-btn');
    expect(r).toMatch(/width:\s*var\(--sw-touch\)/);
    expect(r).toMatch(/height:\s*var\(--sw-touch\)/);
  });

  it('category disclosure summaries keep the full height too (no smaller override)', () => {
    expect(rule(upload, '.sw-cat .sw-details > summary')).toMatch(/padding:\s*12px/);
    expect(rule(upload, '.sw-cat .sw-details > summary')).not.toMatch(/min-height:\s*[0-3]\d?px/);
  });

  it('timeline finding marks keep a 44 px clickable area although the drawn bar is 16 px', () => {
    expect(rule(upload, '.sw-ftimeline')).toMatch(/height:\s*var\(--sw-touch\)/);
    expect(rule(upload, '.sw-fmark')).toMatch(/height:\s*16px/);
    expect(rule(upload, '.sw-fmark::before')).toMatch(/inset:\s*-15px/);
  });

  it('no rule makes a primary control smaller than the shared size', () => {
    for (const [name, source] of [['ui', ui], ['layout', layout], ['upload', upload], ['youtube', youtube]] as const) {
      for (const m of source.matchAll(/([^{}]+)\{([^{}]*min-height:\s*(\d+)px[^{}]*)\}/g)) {
        const selector = m[1]!.trim();
        // Decorative or layout boxes (not controls) may be smaller or larger; controls may not.
        if (/(\.sw-btn|\.sw-input|\.sw-select|\.sw-nav__link|\.sw-source__tab|summary)\b/.test(selector) && Number(m[3]) < 44) {
          throw new Error(`${name}.css: ${selector} has min-height ${m[3]}px (< 44)`);
        }
      }
    }
  });

  it('the one documented exception: context-timeline segments are 24 px tall because lanes are 26 px apart; each is also a full-size list entry', () => {
    expect(rule(upload, '.sw-cseg::before')).toMatch(/inset:\s*-4px -8px/);
    expect(readFileSync(join(process.cwd(), 'src/features/upload/upload.css'), 'utf8')).toMatch(/every segment is also a full-size entry in the list below/);
  });
});
