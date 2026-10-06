import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach } from 'vitest';
import { createTextAnalysis, unavailableTextAnalysis } from '@/domain/text/textAnalysis';
import { filtersStore } from '@/features/filters/filtersStore';
import { processingTextAnalysis, readyTextAnalysis, transcript } from '@/test/textAnalysis';
import { TranscriptPanel } from './TranscriptPanel';

beforeEach(() => { window.localStorage.clear(); filtersStore.reload(); });
const panel = () => screen.getByRole('region', { name: 'Transcript' });

describe('TranscriptPanel', () => {
  it('shows phase-based waiting states without percentages', () => {
    const { rerender } = render(<TranscriptPanel analysis={null} />);
    expect(panel()).toHaveAttribute('aria-busy', 'true');
    expect(panel()).toHaveTextContent('Waiting to transcribe…');
    rerender(<TranscriptPanel analysis={processingTextAnalysis('m', 'speech-processing')} />);
    expect(panel()).toHaveTextContent('Transcribing speech…');
    rerender(<TranscriptPanel analysis={processingTextAnalysis('m', 'building-timeline')} />);
    expect(panel()).toHaveTextContent('Building the text timeline…');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(document.body.textContent).not.toMatch(/\d+%/);
  });

  it('summarises language, segments, subtitle cues and word timing, and says it is text only', async () => {
    render(<TranscriptPanel analysis={readyTextAnalysis('m')} />);
    expect(panel()).toHaveTextContent('Speech1 segment · English');
    expect(panel()).toHaveTextContent('Subtitles2 cues');
    expect(panel()).toHaveTextContent('Word timingYes');
    await userEvent.click(screen.getByText(/Transcript and timeline/));
    expect(panel()).toHaveTextContent('Speech transcribed by whisper.cpp (ggml-base)');
    expect(panel()).toHaveTextContent('SafeWatch has not judged whether anything is safe');
  });

  it('lists the timeline with media-time stamps, sources, evidence and confidence (only when known)', async () => {
    render(<TranscriptPanel analysis={readyTextAnalysis('m')} />);
    await userEvent.click(screen.getByText(/Transcript and timeline \(3 lines\)/));
    const rows = screen.getAllByRole('listitem').filter((li) => li.className.includes('sw-event'));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('0:00.30');
    expect(rows[0]).toHaveTextContent('speech');
    expect(rows[0]).toHaveTextContent('speech + subtitle');
    expect(rows[0]).toHaveTextContent('88%');
    expect(rows[1]).toHaveTextContent('subtitle');
    expect(rows[1]).not.toHaveTextContent('%'); // subtitles have no confidence: never invented
    expect(rows[2]).toHaveTextContent('0:06.50');
    expect(rows[2]).not.toHaveTextContent('speech + subtitle'); // written-only cue
  });

  it('with no filters, points to Custom filters; with enabled filters, lists matches from both sources with timestamps', async () => {
    const { rerender } = render(<TranscriptPanel analysis={readyTextAnalysis('m')} />);
    expect(screen.getByRole('link', { name: 'Custom filters' })).toHaveAttribute('href', '#filters');
    filtersStore.add('SafeWatch', 'phrase');
    rerender(<TranscriptPanel analysis={readyTextAnalysis('m')} />);
    const matches = screen.getAllByRole('listitem').filter((li) => li.className.includes('sw-match'));
    expect(matches).toHaveLength(2);
    // Ordered by time: the subtitle cue (0.20 s) comes before the spoken words (1.50 s).
    const [cue, spoken] = matches;
    expect(cue).toHaveTextContent('subtitle');
    expect(cue).toHaveTextContent('whole cue');
    expect(cue).toHaveTextContent('0:00.20–0:02.90');
    expect(cue).not.toHaveTextContent('%'); // subtitles carry no confidence
    expect(spoken).toHaveTextContent('0:01.50–0:02.40');
    expect(spoken).toHaveTextContent('speech');
    expect(spoken).toHaveTextContent('“safe watch”');
    expect(spoken).toHaveTextContent('for “SafeWatch”');
    expect(spoken).toHaveTextContent('60%'); // lowest confidence among the matched words
  });

  it('reports no matches, ignores disabled filters, and marks matching timeline rows', async () => {
    filtersStore.add('banana', 'word-boundary');
    const { rerender } = render(<TranscriptPanel analysis={readyTextAnalysis('m')} />);
    expect(panel()).toHaveTextContent('No matches for your 1 enabled filter.');
    filtersStore.add('test', 'word-boundary');
    rerender(<TranscriptPanel analysis={readyTextAnalysis('m')} />);
    await userEvent.click(screen.getByText(/Transcript and timeline/));
    expect(screen.getAllByText('match').length).toBe(2);
    filtersStore.toggle(filtersStore.getSnapshot().find((f) => f.phrase === 'test')!.id);
    rerender(<TranscriptPanel analysis={readyTextAnalysis('m')} />);
    expect(screen.queryByText('match')).not.toBeInTheDocument();
  });

  it('lists tracks that were not transcribed instead of hiding them', async () => {
    const base = readyTextAnalysis('m');
    const analysis = { ...base, speech: [...base.speech,
      { audioTrackId: 'aud-1', streamIndex: 2, containerLanguage: 'spa', status: 'skipped' as const, skipReason: 'not-selected' as const, error: null, transcript: null, processingMs: null },
      { audioTrackId: 'aud-2', streamIndex: 3, containerLanguage: null, status: 'failed' as const, skipReason: null, error: 'timeout' as const, transcript: null, processingMs: 5 }] };
    render(<TranscriptPanel analysis={analysis} />);
    await userEvent.click(screen.getByText(/Transcript and timeline/));
    expect(panel()).toHaveTextContent('Audio track 2 (Spanish): not transcribed (another audio track was selected).');
    expect(panel()).toHaveTextContent('Audio track 3: transcription took too long.');
  });

  it('says so when there is no text at all', () => {
    render(<TranscriptPanel analysis={{ ...readyTextAnalysis('m'), speech: [], timeline: [], provider: null }} />);
    expect(panel()).toHaveTextContent('No speech or subtitle text was found in this video.');
    expect(panel()).toHaveTextContent('SpeechNone');
  });

  it('shows a failure as its own error, with media still ready', () => {
    render(<TranscriptPanel analysis={unavailableTextAnalysis('m', 'x', 'server-busy')} />);
    expect(screen.getByRole('alert')).toHaveTextContent('SafeWatch is busy transcribing other videos');
    expect(screen.getByRole('alert')).toHaveTextContent('Your media is still stored and ready.');
  });

  it('renders hostile transcript text as inert text (no HTML, no script)', async () => {
    const evil = '<img src=x onerror=alert(1)><script>window.__pwn=1</script> $(rm -rf /)';
    const a = readyTextAnalysis('m');
    render(<TranscriptPanel analysis={{ ...a, timeline: [{ ...a.timeline[0]!, text: evil, words: null }] }} />);
    await userEvent.click(screen.getByText(/Transcript and timeline/));
    expect(within(panel()).getByText(evil)).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('paginates long timelines instead of rendering thousands of rows', async () => {
    const a = readyTextAnalysis('m');
    const many = Array.from({ length: 120 }, (_, i) => ({ ...a.timeline[1]!, id: `sub-sub-0-${i}`, startSeconds: i, endSeconds: i + 0.5, text: `line ${i}` }));
    render(<TranscriptPanel analysis={{ ...a, timeline: many }} />);
    await userEvent.click(screen.getByText(/Transcript and timeline/));
    expect(screen.getAllByRole('listitem').filter((li) => li.className.includes('sw-event'))).toHaveLength(50);
    await userEvent.click(screen.getByRole('button', { name: /Show more \(70 left\)/ }));
    expect(screen.getAllByRole('listitem').filter((li) => li.className.includes('sw-event'))).toHaveLength(100);
  });

  it('marks approximate word timing honestly', () => {
    const a = readyTextAnalysis('m');
    const t = transcript('m', { wordTiming: 'decoder' });
    render(<TranscriptPanel analysis={{ ...a, speech: [{ ...a.speech[0]!, transcript: t }] }} />);
    expect(panel()).toHaveTextContent('Word timingApproximate');
  });

  it('a not-started analysis object still shows a waiting state', () => {
    render(<TranscriptPanel analysis={createTextAnalysis('m', 'x')} />);
    expect(panel()).toHaveAttribute('aria-busy', 'true');
  });
});
