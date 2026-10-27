import { INITIAL_YOUTUBE_STATE, youTubeCapabilities, youTubeSourceReducer as reduce, type CaptionSource, type YouTubeSourceAction, type YouTubeSourceState } from './sourceState';

const ID = 'dQw4w9WgXcQ';
const CAPS: CaptionSource = { fileName: 'a.srt', format: 'srt', cueCount: 3, firstStartSeconds: 1, lastEndSeconds: 72 };
const run = (actions: YouTubeSourceAction[], from: YouTubeSourceState = INITIAL_YOUTUBE_STATE) => actions.reduce(reduce, from);

describe('YouTube source state', () => {
  it('starts idle with the analysis capability unavailable', () => {
    expect(INITIAL_YOUTUBE_STATE).toEqual({ videoId: null, player: 'idle', playerError: null, captions: null, analysis: 'unavailable' });
  });

  it('walks the player: source validated → loading → ready', () => {
    const s1 = run([{ type: 'validated', videoId: ID }]);
    expect(s1).toMatchObject({ videoId: ID, player: 'source-validated', analysis: 'unavailable' });
    expect(run([{ type: 'player-loading' }], s1).player).toBe('player-loading');
    expect(run([{ type: 'player-loading' }, { type: 'player-ready' }], s1).player).toBe('player-ready');
  });

  it('refuses to become ready without loading, and ignores everything before a source exists', () => {
    expect(run([{ type: 'player-ready' }])).toEqual(INITIAL_YOUTUBE_STATE);
    expect(run([{ type: 'player-loading' }])).toEqual(INITIAL_YOUTUBE_STATE);
    expect(run([{ type: 'captions-added', captions: CAPS }])).toEqual(INITIAL_YOUTUBE_STATE);
    expect(run([{ type: 'validated', videoId: 'nope' }])).toEqual(INITIAL_YOUTUBE_STATE);
  });

  it('keeps a player error with its kind, and a retry clears it', () => {
    const e = run([{ type: 'validated', videoId: ID }, { type: 'player-loading' }, { type: 'player-error', kind: 'embedding-disabled' }]);
    expect(e).toMatchObject({ player: 'player-error', playerError: 'embedding-disabled' });
    expect(reduce(e, { type: 'player-loading' })).toMatchObject({ player: 'player-loading', playerError: null });
  });

  it('analysis: unavailable → pending (captions added) → in-progress → partial', () => {
    let s = run([{ type: 'validated', videoId: ID }]);
    expect(s.analysis).toBe('unavailable');
    s = reduce(s, { type: 'captions-added', captions: CAPS }); expect(s.analysis).toBe('pending');
    s = reduce(s, { type: 'analysis-started' }); expect(s.analysis).toBe('in-progress');
    s = reduce(s, { type: 'analysis-finished' }); expect(s.analysis).toBe('partial');
  });

  it('a finished analysis is never "complete" unless full coverage is explicitly claimed (no YouTube source can claim it today)', () => {
    const base = run([{ type: 'validated', videoId: ID }, { type: 'captions-added', captions: CAPS }, { type: 'analysis-started' }]);
    expect(reduce(base, { type: 'analysis-finished' }).analysis).toBe('partial');
    expect(reduce(base, { type: 'analysis-finished', fullCoverage: false }).analysis).toBe('partial');
    expect(reduce(base, { type: 'analysis-finished', fullCoverage: true }).analysis).toBe('complete');
  });

  it('analysis failure is recorded, and results that arrive out of order are ignored', () => {
    const pending = run([{ type: 'validated', videoId: ID }, { type: 'captions-added', captions: CAPS }]);
    expect(reduce(pending, { type: 'analysis-failed' }).analysis).toBe('failed');
    expect(reduce(pending, { type: 'analysis-finished' })).toEqual(pending); // not started: ignored
    const done = run([{ type: 'analysis-started' }, { type: 'analysis-finished' }], pending);
    expect(reduce(done, { type: 'analysis-failed' })).toEqual(done);
  });

  it('removing the captions returns to "unavailable" and keeps the player', () => {
    const s = run([{ type: 'validated', videoId: ID }, { type: 'player-loading' }, { type: 'player-ready' }, { type: 'captions-added', captions: CAPS }, { type: 'captions-removed' }]);
    expect(s).toMatchObject({ player: 'player-ready', captions: null, analysis: 'unavailable' });
  });

  it('a different video starts from scratch: no captions, analysis or error leaks across', () => {
    const first = run([{ type: 'validated', videoId: ID }, { type: 'captions-added', captions: CAPS }, { type: 'analysis-started' }, { type: 'analysis-finished' }]);
    const second = reduce(first, { type: 'validated', videoId: 'aaaaaaaaaaa' });
    expect(second).toEqual({ videoId: 'aaaaaaaaaaa', player: 'source-validated', playerError: null, captions: null, analysis: 'unavailable' });
    expect(reduce(first, { type: 'reset' })).toEqual(INITIAL_YOUTUBE_STATE);
  });
});

describe('youTubeCapabilities: honest about what exists', () => {
  const get = (s: YouTubeSourceState, id: string) => youTubeCapabilities(s).find((c) => c.id === id)!;
  const analysed = run([{ type: 'validated', videoId: ID }, { type: 'captions-added', captions: CAPS }, { type: 'analysis-started' }, { type: 'analysis-finished' }]);

  it('without captions: nothing can be analysed, and the reason says where to get it', () => {
    const s = run([{ type: 'validated', videoId: ID }]);
    expect(get(s, 'captions-phrases')).toMatchObject({ status: 'unavailable' });
    expect(get(s, 'captions-phrases').limits).toMatch(/owner/i);
    expect(get(s, 'warnings').status).toBe('unavailable');
    expect(get(s, 'actions').status).toBe('unavailable');
  });

  it('with analysed captions: phrases, warnings and actions are available, with provenance and limits', () => {
    expect(get(analysed, 'captions-phrases')).toMatchObject({ status: 'available' });
    expect(get(analysed, 'captions-phrases').source).toMatch(/file you provided/i);
    expect(get(analysed, 'captions-phrases').limits).toMatch(/incomplete/i);
    expect(get(analysed, 'warnings').status).toBe('available');
    expect(get(analysed, 'actions').limits).toMatch(/whole player/i);
  });

  it('speech and scene categories are never available for a YouTube source, whatever else is true', () => {
    for (const s of [INITIAL_YOUTUBE_STATE, analysed]) {
      expect(get(s, 'speech-phrases').status).toBe('unavailable');
      expect(get(s, 'scene-categories').status).toBe('unsupported');
      expect(get(s, 'speech-phrases').limits).toMatch(/local file/i);
    }
  });
});
