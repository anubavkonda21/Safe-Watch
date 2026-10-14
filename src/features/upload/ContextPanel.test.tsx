import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildContextAnalysis, unavailableContext } from '@/domain/context/contextAnalysis';
import { speech, subtitle, visual } from '@/test/context';
import { correlateEvidence } from '@/domain/context/correlate';
import { DEFAULT_CONTEXT_CONFIG } from '@/domain/context/contextEvent';
import { readyContext } from '@/test/contextAnalysis';
import { unavailableVisual } from '@/domain/vision/visualAnalysis';
import { readyTextAnalysis } from '@/test/textAnalysis';
import { readyVisual } from '@/test/visualAnalysis';
import { ContextBadge, ContextPanel } from './ContextPanel';

const panel = () => screen.getByRole('region', { name: 'Contextual evidence' });

describe('ContextPanel waiting and failure states', () => {
  it('shows a busy, percentage-free state while evidence is still being produced', () => {
    const { rerender } = render(<ContextPanel context={null} />);
    expect(panel()).toHaveAttribute('aria-busy', 'true');
    expect(panel()).toHaveTextContent('Grouping speech, subtitles and visual evidence by time…');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    rerender(<ContextPanel context={buildContextAnalysis({ mediaId: 'm', extractionStatus: 'processing', mediaDurationSeconds: 5, text: null, visual: null, frameStepSeconds: null })} />);
    expect(panel()).toHaveAttribute('aria-busy', 'true');
  });
  it('says plainly when nothing could be correlated, without an alarm', () => {
    render(<ContextPanel context={unavailableContext('m')} />);
    expect(panel()).toHaveTextContent('Evidence could not be grouped by time');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('says so when the earlier steps found no evidence at all', () => {
    const empty = buildContextAnalysis({ mediaId: 'm', extractionStatus: 'completed', mediaDurationSeconds: 5, text: { ...readyTextAnalysis('m'), speech: [], timeline: [] }, visual: { ...readyVisual('m'), observations: [], frames: [] }, frameStepSeconds: 1 });
    render(<ContextPanel context={empty} />);
    expect(panel()).toHaveTextContent('found no speech, subtitles or visual evidence to correlate');
    expect(screen.queryByRole('list', { name: 'Contexts' })).not.toBeInTheDocument();
  });
});
describe('ContextPanel (ready)', () => {
  it('summarises contexts and evidence counts and states what it is and is not', () => {
    render(<ContextPanel context={readyContext('m')} />);
    expect(panel()).toHaveTextContent(/Contexts\d/);
    expect(panel()).toHaveTextContent('grouped the evidence above by time');
    expect(panel()).toHaveTextContent('It has not assessed the content');
    expect(panel()).toHaveTextContent('Each source keeps its own confidence; they are never combined');
  });
  it('lists contexts chronologically with media time, source badges and evidence facts', () => {
    render(<ContextPanel context={readyContext('m')} />);
    const cards = within(screen.getByRole('list', { name: 'Contexts' })).getAllByRole('button');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards[0]).toHaveTextContent('Speech');
    expect(cards[0]).toHaveTextContent('Subtitles');
    expect(cards[0]).toHaveTextContent('Visual');
    expect(cards[0]).toHaveTextContent('Speech available');
    expect(cards[0]).toHaveTextContent(/\d:\d\d\.\d\d/);
    const times = cards.map((c) => c.querySelector('.sw-ccard__time')!.textContent!);
    expect(times).toEqual([...times].sort((a, b) => parseFloat(a.replace(':', '.')) - parseFloat(b.replace(':', '.'))));
  });
  it('draws one timeline segment per context, named by time and sources, and selecting either one reveals the same evidence', async () => {
    render(<ContextPanel context={readyContext('m')} />);
    const timeline = screen.getByRole('group', { name: 'Context timeline' });
    const segments = within(timeline).getAllByRole('button');
    expect(segments).toHaveLength(within(screen.getByRole('list', { name: 'Contexts' })).getAllByRole('button').length);
    expect(segments[0]).toHaveAccessibleName(/^Context .*Speech, Subtitles, Visual$/);
    expect(screen.getByText('Select a context to see the evidence behind it.')).toBeInTheDocument();
    await userEvent.click(segments[0]!);
    expect(segments[0]).toHaveAttribute('aria-pressed', 'true');
    const drill = screen.getByRole('region', { name: /^Evidence for context/ });
    expect(drill).toBeInTheDocument();
    await userEvent.click(segments[0]!);
    expect(screen.queryByRole('region', { name: /^Evidence for context/ })).not.toBeInTheDocument();
  });
  it('drill-down shows every piece of evidence by source with time, confidence and WHY it was grouped', async () => {
    render(<ContextPanel context={readyContext('m')} />);
    await userEvent.click(within(screen.getByRole('list', { name: 'Contexts' })).getAllByRole('button')[0]!);
    const drill = screen.getByRole('region', { name: /^Evidence for context/ });
    expect(within(drill).getByRole('heading', { name: /Speech \(1\)/ })).toBeInTheDocument();
    expect(within(drill).getByRole('heading', { name: /Subtitles \(2\)/ })).toBeInTheDocument();
    expect(within(drill).getByRole('heading', { name: /Visual \(/ })).toBeInTheDocument();
    expect(drill).toHaveTextContent('Hello, this is a safe watch test.'); // the transcript wording, shown as evidence
    expect(drill).toHaveTextContent('88%'); // speech segment confidence, its own
    expect(drill).toHaveTextContent('Started this context');
    expect(drill).toHaveTextContent('Overlaps in time');
    expect(drill).toHaveTextContent(/Confidence by source: speech 88%/);
    expect(drill).toHaveTextContent('subtitles not reported'); // subtitles have no confidence: never invented
    expect(drill).toHaveTextContent(/The next evidence is more than 1.5 s away|There is no later evidence|cut at/);
  });
  it('explains frame coverage and long evidence in plain words', async () => {
    const evidence = [speech('s', 10, 11.5), visual('f', 15), subtitle('long', 0, 60)];
    const { events } = correlateEvidence({ evidence, visualStepMs: 10_000 });
    const context = { ...readyContext('m'), events, counts: { eventCount: events.length, evidenceCount: 3, invalidEvidence: 0, duplicateEvidence: 0 }, config: DEFAULT_CONTEXT_CONFIG, durationMs: 60_000 };
    render(<ContextPanel context={context} />);
    const cards = within(screen.getByRole('list', { name: 'Contexts' })).getAllByRole('button');
    expect(cards.some((c) => c.textContent!.includes('Long-lasting evidence'))).toBe(true);
    const mixed = cards.find((c) => c.textContent!.includes('Speech available') && c.textContent!.includes('Visual'))!;
    await userEvent.click(mixed);
    const drill = screen.getByRole('region', { name: /^Evidence for context/ });
    expect(drill).toHaveTextContent('The frame stands for this moment');
    expect(drill).toHaveTextContent('Also during this time');
    expect(drill).toHaveTextContent('Lasts longer than a context, so it is listed here without being merged');
  });
  it('reports missing evidence honestly: a partial result names what is missing', () => {
    const partial = readyContext('m', { visual: unavailableVisual('m', 'x', 'provider-unavailable') });
    render(<ContextPanel context={partial} />);
    expect(panel()).toHaveTextContent('Visual evidence is not enabled on this server, so it is missing from the contexts below.');
    expect(screen.getAllByRole('button').every((b) => !b.textContent!.includes('Visual'))).toBe(true);
    const failed = readyContext('m', { visual: unavailableVisual('m', 'x', 'timeout') });
    const { container } = render(<ContextPanel context={failed} />);
    expect(container).toHaveTextContent('Visual evidence could not be read');
  });
  it('shows hostile evidence text as inert plain text', async () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const context = readyContext('m');
    const first = context.events[0]!;
    const hacked = { ...context, events: [{ ...first, members: first.members.map((m) => ({ ...m, label: hostile })) }, ...context.events.slice(1)] };
    render(<ContextPanel context={hacked} />);
    await userEvent.click(within(screen.getByRole('list', { name: 'Contexts' })).getAllByRole('button')[0]!);
    expect(screen.getByRole('region', { name: /^Evidence for context/ })).toHaveTextContent(hostile);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
  it('uses no assessment vocabulary of its own', async () => {
    render(<ContextPanel context={readyContext('m')} />);
    await userEvent.click(within(screen.getByRole('list', { name: 'Contexts' })).getAllByRole('button')[0]!);
    const own = [...document.body.querySelectorAll('.sw-ccard__facts, .sw-context > p, .sw-cdrill > p, .sw-cdrill h4, .sw-cdrill h5, .sw-cmember__body > .sw-caption, .sw-context__notes p')].map((n) => n.textContent).join(' ');
    expect(own).not.toMatch(/\b(safe|unsafe|danger|dangerous|explicit|violent|violence|sexual|drug|drugs|graphic|verdict|risk|score)\b/i);
  });
});

describe('ContextBadge', () => {
  it.each([[null, 'Context: in progress'], [readyContext('m'), 'Context: ready'], [readyContext('m', { visual: null }), 'Context: partial'], [unavailableContext('m'), 'Context: unavailable']] as const)('%#', (context, text) => {
    render(<ContextBadge context={context} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
