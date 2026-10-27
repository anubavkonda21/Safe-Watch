import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { HomePage } from './HomePage';

beforeEach(() => { window.localStorage.clear(); });

// The two honest negations ("does not mean a video is safe", "not thereby safe") are the opposite of the claim being forbidden.
const page = () => { render(<HomePage />); return (document.body.textContent ?? '').replace(/does not mean a video is safe|is not thereby safe/g, ''); };
const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/**
 * The landing page makes claims about what SafeWatch does and where data goes. Each claim here was once false, overstated or
 * outdated, so the test pins the wording: a future edit that reintroduces one fails.
 */
describe('landing page copy is truthful', () => {
  it.each([
    ['says nothing is uploaded (files ARE uploaded to the SafeWatch server)', /nothing is uploaded/i],
    ['says the analysis engine is not built', /engine is not (yet )?built/i],
    ['says analysis is not available', /analysis features are not yet available/i],
    ['labels working features as planned', /planned capabilities|\bplanned\b/i],
    ['claims scenes are read', /scenes together|reads speech, subtitles and scenes/i],
    ['claims masking', /\bmask(s|ed|ing)?\b/i],
    ['claims a safety timeline before play', /before you press play|safety timeline|pre-playback summary/i],
    ['claims the product looks inside the picture', /looks inside a video/i],
    ['sells it as AI-powered safety', /ai-powered/i],
    ['gives a score or guarantee', /100%|guarantee|fully protected|\b(is|are|marked|rated|declared|deemed) (completely |totally )?safe\b/i],
  ])('never %s', (_name, pattern) => {
    expect(page()).not.toMatch(pattern);
  });

  it('describes local files accurately: uploaded to the SafeWatch server (by default on this computer), checked with local tools, kept temporarily, then deleted', () => {
    page();
    const privacy = within(document.getElementById('safety')!);
    expect(privacy.getByText(/is uploaded to your SafeWatch server, which by default runs on this computer/)).toBeInTheDocument();
    expect(privacy.getByText(/checked there with local tools/)).toBeInTheDocument();
    expect(privacy.getByText(/kept for a limited time \(60 minutes by default\) and then deleted/)).toBeInTheDocument();
    expect(privacy.getByText(/No outside service is used for it/)).toBeInTheDocument();
  });

  it('discloses that a YouTube link contacts YouTube and what YouTube receives', () => {
    page();
    const privacy = within(document.getElementById('safety')!);
    expect(privacy.getByText(/Loading it contacts YouTube/)).toBeInTheDocument();
    expect(privacy.getByText(/normal player information such as your IP address and browser details/)).toBeInTheDocument();
  });

  it('never implies that SafeWatch can see or hear an embedded YouTube video, or read its captions', () => {
    const text = page();
    expect(text).toMatch(/cannot see or hear a YouTube video and cannot read its captions/);
    expect(text).toMatch(/SafeWatch cannot hear or see a YouTube video/);
    expect(text).not.toMatch(/analy[sz]e (a |the )?YouTube (video|stream)|YouTube (audio|frames)|reads? YouTube/i);
  });

  it('distinguishes local-file analysis from YouTube caption-file checking', () => {
    page();
    const how = within(document.getElementById('how-it-works')!);
    expect(how.getByText(/For a file, your words are matched against its speech and subtitles\. For YouTube, against a caption file you add/)).toBeInTheDocument();
    expect(how.getByText('Speech: files only')).toBeInTheDocument();
  });

  it('says where the user’s words go: this browser, the SafeWatch server for files, never YouTube', () => {
    page();
    const privacy = within(document.getElementById('safety')!);
    expect(privacy.getByText(/saved in this browser/)).toBeInTheDocument();
    expect(privacy.getByText(/sent to your SafeWatch server so it can match them; it does not store or log them\. They are never sent to YouTube/)).toBeInTheDocument();
    expect(within(document.getElementById('filters')!).getByText(/For a YouTube video the matching happens in this browser and nothing goes to the server/)).toBeInTheDocument();
  });

  it('names the unsupported categories as NOT detected, in the product section and in the privacy section', () => {
    page();
    for (const id of ['product', 'safety']) {
      const section = document.getElementById(id)!;
      expect(section.textContent).toMatch(/sexual content, violence, graphic injury or drug-related/);
      expect(section.textContent).toMatch(/does not (do this|detect)/);
    }
  });

  it('says that no findings is not "safe" and that there is no score', () => {
    page();
    expect(document.getElementById('safety')!.textContent).toMatch(/gives no score, and a video with no findings is not thereby safe/);
  });

  it('every step of "How it works" is described as working today, none as planned', () => {
    page();
    const steps = within(document.getElementById('how-it-works')!).getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    for (const s of steps) expect(s.textContent).not.toMatch(/planned|preview|coming|later release/i);
  });

  it('the illustration is labelled as an illustration and as not real, for assistive technology too', () => {
    page();
    const fig = screen.getByRole('figure', { name: /Illustration only/ });
    expect(fig).toHaveAccessibleName(/Not real results/);
    expect(fig.textContent).toMatch(/not a real result/);
    expect(fig.textContent).toMatch(/does not detect scenes today/);
  });

  it('the footer and the page description make no claim the application contradicts', () => {
    page();
    expect(screen.getByRole('contentinfo').textContent).toMatch(/Early version: it checks only the words and phrases you list/);
    const html = read('index.html');
    expect(html).toMatch(/<meta name="description" content="[^"]*finds the words and phrases you list/);
    expect(html).not.toMatch(/ai-powered|safety platform/i);
  });
});
