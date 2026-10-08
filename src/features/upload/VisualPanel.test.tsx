import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { failVisual, unavailableVisual } from '@/domain/vision/visualAnalysis';
import { processingVisual, readyVisual, visualFrame } from '@/test/visualAnalysis';
import { createVisualAnalysis, queueVisual, startVisual, completeVisual } from '@/domain/vision/visualAnalysis';
import { VisualBadge, VisualPanel } from './VisualPanel';

const frameUrl = (id: string) => `http://api.test/api/media/m/frames/${id}`;
const panel = () => screen.getByRole('region', { name: 'Visual evidence' });

describe('VisualPanel waiting states', () => {
  it('shows real frame progress while analysing, and no invented percentage when none is measurable', () => {
    const { rerender } = render(<VisualPanel analysis={null} frameUrl={frameUrl} />);
    expect(panel()).toHaveAttribute('aria-busy', 'true');
    expect(panel()).toHaveTextContent('Waiting to look at the frames…');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    rerender(<VisualPanel analysis={processingVisual('m', 'analyzing-frames', { framesDone: 8, framesTotal: 20 })} frameUrl={frameUrl} />);
    expect(panel()).toHaveTextContent('Looking at frame 9 of 20…');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    rerender(<VisualPanel analysis={processingVisual('m', 'building-timeline')} frameUrl={frameUrl} />);
    expect(panel()).toHaveTextContent('Building the visual timeline…');
  });
});

describe('VisualPanel failures', () => {
  const failed = (code: Parameters<typeof unavailableVisual>[2]) => unavailableVisual('m', 'x', code);
  it('says visual analysis is not enabled (informational, not an error) when no provider is configured', () => {
    render(<VisualPanel analysis={failed('provider-unavailable')} frameUrl={frameUrl} />);
    expect(screen.getByText('Visual analysis is not enabled on this server').closest('[role]')).not.toHaveAttribute('role', 'alert');
    expect(panel()).toHaveTextContent('Your media is still stored and ready.');
  });
  it.each([
    ['server-busy', 'SafeWatch is busy looking at other videos'], ['server-unreachable', 'We lost contact with the SafeWatch server'], ['timeout', 'Looking at the frames took too long'],
    ['frame-missing', 'The sampled frames are no longer available'], ['inference-failed', 'The frames could not be analyzed'],
  ] as const)('%s → plain-language error', (code, title) => {
    render(<VisualPanel analysis={failed(code)} frameUrl={frameUrl} />);
    expect(screen.getByRole('alert')).toHaveTextContent(title);
  });
  it('shows fixed text only: provider output never reaches the UI', () => {
    const a = failVisual(processingVisual('m', 'analyzing-frames'), { code: 'inference-failed', stage: 'provider', fatal: true, count: 1 }, 'x');
    render(<VisualPanel analysis={a} frameUrl={frameUrl} />);
    expect(document.body.textContent).not.toMatch(/\/Users|\.jpg|stack|Error:/);
  });
});

describe('VisualPanel evidence', () => {
  it('summarises analysed frames, observations and time, and says it is visual evidence only', () => {
    render(<VisualPanel analysis={readyVisual('m')} frameUrl={frameUrl} />);
    expect(panel()).toHaveTextContent('Frames analyzed2 of 3');
    expect(panel()).toHaveTextContent('Observations5');
    expect(panel()).toHaveTextContent('Time450 ms');
    expect(panel()).toHaveTextContent('described on this device by apple-vision');
    expect(panel()).toHaveTextContent('Labels are what a model reports, not facts: they can be wrong');
    expect(panel()).toHaveTextContent('SafeWatch has not judged whether anything is safe');
  });
  it('lists every sampled frame chronologically with media time, top labels and OCR text; unreadable frames have no image', () => {
    render(<VisualPanel analysis={readyVisual('m')} frameUrl={frameUrl} />);
    const cards = within(screen.getByRole('list', { name: 'Sampled frames' })).getAllByRole('button');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveAccessibleName('Open frame at 0:01.50, 2 observations');
    expect(cards[0]).toHaveTextContent('living room, furniture');
    expect(cards[1]).toHaveTextContent('0:04.50');
    expect(cards[1]).toHaveTextContent('“STOP”');
    expect(cards[2]).toHaveTextContent('Not available');
    expect(cards[2]!.querySelector('img')).toBeNull();
    const img = cards[0]!.querySelector('img')!;
    expect(img).toHaveAttribute('src', 'http://api.test/api/media/m/frames/frm-00000');
    expect(img).toHaveAttribute('loading', 'lazy');
  });
  it('explains frames with no observations in the notes, in plain language', async () => {
    render(<VisualPanel analysis={readyVisual('m')} frameUrl={frameUrl} />);
    await userEvent.click(screen.getByText(/Notes \(1 note\)/));
    expect(panel()).toHaveTextContent('Frame at 0:07.50 could not be read as an image.');
  });
  it('paginates large timelines instead of rendering every frame at once', async () => {
    const frames = Array.from({ length: 30 }, (_, i) => visualFrame(i, i + 0.5));
    const a = completeVisual(startVisual(queueVisual(createVisualAnalysis('m', 'x')), 'x'), { frames, observations: [], provider: null, issues: [], metrics: { durationMs: 1, providerMs: 1, batches: 1 } }, 'x');
    render(<VisualPanel analysis={a} frameUrl={frameUrl} />);
    expect(screen.getAllByRole('button').filter((b) => b.className.includes('sw-frame'))).toHaveLength(12);
    await userEvent.click(screen.getByRole('button', { name: /Show more frames \(18 left\)/ }));
    expect(screen.getAllByRole('button').filter((b) => b.className.includes('sw-frame'))).toHaveLength(24);
  });
  it('a video with no sampled frames says so', () => {
    const a = completeVisual(startVisual(queueVisual(createVisualAnalysis('m', 'x')), 'x'), { frames: [], observations: [], provider: null, issues: [{ code: 'no-frames', stage: 'frames', fatal: false, count: 0 }], metrics: { durationMs: 1, providerMs: 0, batches: 0 } }, 'x');
    render(<VisualPanel analysis={a} frameUrl={frameUrl} />);
    expect(panel()).toHaveTextContent('No frames were sampled from this video.');
  });
});

describe('frame preview', () => {
  it('opens a dialog with the frame, its observations (label, kind, confidence) and boxes that can be hidden', async () => {
    render(<VisualPanel analysis={readyVisual('m')} frameUrl={frameUrl} />);
    await userEvent.click(screen.getByRole('button', { name: /Open frame at 0:04.50/ }));
    const dialog = screen.getByRole('dialog', { name: 'Frame at 0:04.50' });
    expect(within(dialog).getByRole('img', { name: 'Sampled frame at 0:04.50' })).toHaveAttribute('src', 'http://api.test/api/media/m/frames/frm-00001');
    const rows = within(dialog).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('objectperson82%');
    expect(rows[1]).toHaveTextContent('text“STOP”100%');
    expect(rows[2]).toHaveTextContent('labelstreet sign77%');
    const boxes = () => dialog.querySelectorAll('.sw-box');
    expect(boxes()).toHaveLength(2);
    expect((boxes()[0] as HTMLElement).style.left).toBe('55%');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Show boxes' }));
    expect(boxes()).toHaveLength(0);
  });
  it('shows an honest empty state for a frame the model reported nothing about, and never shows safety words', async () => {
    const a = readyVisual('m');
    render(<VisualPanel analysis={{ ...a, observations: a.observations.filter((o) => o.frameId !== 'frm-00000') }} frameUrl={frameUrl} />);
    await userEvent.click(screen.getByRole('button', { name: /Open frame at 0:01.50/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('The model reported nothing for this frame.');
    expect(document.body.textContent).not.toMatch(/\bunsafe\b|(video|media|content|frame) (is|are) safe|verdict|risk score/i);
  });
  it('keeps hostile labels and OCR text inert: rendered as plain text, never as markup', async () => {
    const a = readyVisual('m');
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const hacked = { ...a, observations: a.observations.map((o) => (o.type === 'text' ? { ...o, attributes: { text: hostile } } : { ...o, label: hostile })) };
    render(<VisualPanel analysis={hacked} frameUrl={frameUrl} />);
    await userEvent.click(screen.getByRole('button', { name: /Open frame at 0:04.50/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent(hostile);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
});

describe('VisualBadge', () => {
  it.each([
    [null, 'Visual: queued'], [processingVisual('m', 'analyzing-frames'), 'Visual: in progress'], [readyVisual('m'), 'Visual: ready'],
    [unavailableVisual('m', 'x', 'timeout'), 'Visual: failed'], [unavailableVisual('m', 'x', 'provider-unavailable'), 'Visual: not enabled'],
  ] as const)('%#', (analysis, text) => {
    render(<VisualBadge analysis={analysis} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });
});
