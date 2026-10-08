import { compareObservations, humanizeLabel, isValidRegion, normalizeObservation, sortObservations, type ObservationContext, type VisualObservation } from './observation';

const ctx: ObservationContext = { frameId: 'frm-00003', frameIndex: 3, timestampSeconds: 12.5, provider: 'apple-vision', model: 'vision-framework' };

describe('normalizeObservation', () => {
  it('builds a timestamped observation on the frame timeline; time comes from the frame, never the provider', () => {
    const { observation, issues } = normalizeObservation({ type: 'classification', label: 'living_room', confidence: 0.9, timestampSeconds: 99 } as never, ctx, 0);
    expect(issues).toEqual([]);
    expect(observation).toEqual({
      id: 'vis-frm-00003-0', frameId: 'frm-00003', frameIndex: 3, timestampSeconds: 12.5, type: 'classification', label: 'living_room',
      confidence: 0.9, region: null, attributes: null, provider: 'apple-vision', model: 'vision-framework',
    });
  });
  it('keeps a valid region and OCR text', () => {
    const { observation } = normalizeObservation({ type: 'text', label: 'text', confidence: 1, region: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 }, text: '  STOP\u0000 ' }, ctx, 1);
    expect(observation?.region).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.1 });
    expect(observation?.attributes).toEqual({ text: 'STOP' });
  });
  it.each(['safe', 'unsafe', 'violence', undefined, 5, null])('drops an unknown type (%s): there are no safety types', (type) => {
    expect(normalizeObservation({ type, label: 'x' }, ctx, 0)).toEqual({ observation: null, issues: ['invalid-type'] });
  });
  it.each(['', '   ', '\u0000', undefined, 7])('drops an empty or non-string label (%j)', (label) => {
    expect(normalizeObservation({ type: 'object', label }, ctx, 0)).toEqual({ observation: null, issues: ['empty-label'] });
  });
  it.each([-0.1, 1.01, NaN, Infinity, '0.5'])('turns an out-of-range confidence (%j) into null instead of repairing it', (confidence) => {
    const { observation, issues } = normalizeObservation({ type: 'object', label: 'person', confidence }, ctx, 0);
    expect(observation?.confidence).toBeNull();
    expect(issues).toEqual(['invalid-confidence']);
  });
  it('keeps a missing confidence as null without an issue (never invented)', () => {
    const { observation, issues } = normalizeObservation({ type: 'object', label: 'person' }, ctx, 0);
    expect(observation?.confidence).toBeNull();
    expect(issues).toEqual([]);
  });
  it.each([
    { x: -0.1, y: 0, width: 0.5, height: 0.5 }, { x: 0.8, y: 0, width: 0.5, height: 0.5 }, { x: 0, y: 0, width: 0, height: 0.5 },
    { x: 0, y: 0, width: 0.5, height: NaN }, { x: 0, y: 0 }, 'box', [],
  ])('removes an invalid region (%j) but keeps the observation', (region) => {
    const { observation, issues } = normalizeObservation({ type: 'object', label: 'person', confidence: 0.5, region }, ctx, 0);
    expect(observation?.region).toBeNull();
    expect(issues).toEqual(['invalid-region']);
  });
  it('bounds label and text length', () => {
    const { observation } = normalizeObservation({ type: 'text', label: 'x'.repeat(500), text: 'y'.repeat(5000) }, ctx, 0);
    expect(observation!.label.length).toBe(80);
    expect(observation!.attributes!.text!.length).toBe(200);
  });
  it('never interprets labels: markup stays plain text', () => {
    const { observation } = normalizeObservation({ type: 'classification', label: '<img src=x onerror=alert(1)>' }, ctx, 0);
    expect(observation!.label).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('isValidRegion', () => {
  it('accepts a full-frame box and rejects a box leaving the frame', () => {
    expect(isValidRegion({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(isValidRegion({ x: 0.5, y: 0.5, width: 0.6, height: 0.2 })).toBe(false);
  });
});

const obs = (over: Partial<VisualObservation>): VisualObservation => ({
  id: 'vis-a-0', frameId: 'a', frameIndex: 0, timestampSeconds: 0, type: 'classification', label: 'a', confidence: 0.5, region: null, attributes: null, provider: 'p', model: 'm', ...over,
});

describe('observation ordering', () => {
  it('orders by time, then frame index, then type, then confidence (high first, unknown last), then label, then id', () => {
    const list = [
      obs({ id: 'z', timestampSeconds: 5 }),
      obs({ id: 'c1', type: 'classification', confidence: 0.2, label: 'b' }),
      obs({ id: 'c2', type: 'classification', confidence: 0.9, label: 'a' }),
      obs({ id: 'cn', type: 'classification', confidence: null, label: 'a' }),
      obs({ id: 'o', type: 'object', confidence: 0.1 }),
      obs({ id: 't', type: 'text', confidence: 1 }),
      obs({ id: 'f2', frameIndex: 1, timestampSeconds: 0 }),
    ];
    expect(sortObservations(list).map((o) => o.id)).toEqual(['o', 't', 'c2', 'c1', 'cn', 'f2', 'z']);
  });
  it('is deterministic for ties and does not mutate its input', () => {
    const a = obs({ id: 'b' }); const b = obs({ id: 'a' });
    const input = [a, b];
    expect(sortObservations(input).map((o) => o.id)).toEqual(['a', 'b']);
    expect(sortObservations([b, a]).map((o) => o.id)).toEqual(['a', 'b']);
    expect(input[0]).toBe(a);
    expect(compareObservations(a, a)).toBe(0);
  });
});

describe('humanizeLabel', () => {
  it('only changes how a label is shown', () => {
    expect(humanizeLabel('ski_equipment')).toBe('ski equipment');
  });
});
