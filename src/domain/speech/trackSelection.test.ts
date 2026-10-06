import type { AudioAsset } from '../extraction/extraction';
import { primaryLanguage, selectAudioTracks } from './trackSelection';

const disp = { default: false, forced: false, original: false, hearingImpaired: false, commentary: false };
const track = (ordinal: number, over: Partial<AudioAsset> = {}): AudioAsset => ({
  id: `aud-${ordinal}`, ordinal, streamIndex: ordinal + 1, language: null, title: null, disposition: disp,
  source: { codec: 'aac', sampleRate: 48000, channels: 2, bitRate: null }, format: { container: 'wav', codec: 'pcm_s16le', sampleRate: 16000, channels: 1 },
  durationSeconds: 10, sizeBytes: 1000, artifact: `audio/aud-${ordinal}.wav`, duplicateOf: null, ...over,
});
const pick = (audio: AudioAsset[], preferredLanguage: string | null = null, maxTracks = 1) => selectAudioTracks(audio, { preferredLanguage, maxTracks });

describe('selectAudioTracks', () => {
  it('returns nothing for media with no audio', () => expect(pick([])).toEqual({ selected: [], skipped: [] }));
  it('takes the only track', () => expect(pick([track(0)]).selected).toEqual(['aud-0']));
  it('prefers the preferred language over container order', () => {
    const audio = [track(0, { language: 'eng' }), track(1, { language: 'hin' })];
    expect(pick(audio, 'hi').selected).toEqual(['aud-1']);
    expect(pick(audio, 'en').selected).toEqual(['aud-0']);
  });
  it('maps three-letter container tags to two-letter codes', () => {
    expect(primaryLanguage('eng')).toBe('en');
    expect(primaryLanguage('hin')).toBe('hi');
    expect(primaryLanguage('pt-br')).toBe('pt');
    expect(primaryLanguage('xxx')).toBeNull();
    expect(primaryLanguage(null)).toBeNull();
  });
  it('ranks matching language, then unknown language, then other languages', () => {
    const audio = [track(0, { language: 'fra' }), track(1, { language: null }), track(2, { language: 'eng' })];
    expect(pick(audio, 'en', 3).selected).toEqual(['aud-2', 'aud-1', 'aud-0']);
  });
  it('without a preference, the default-flagged track wins over container order', () => {
    expect(pick([track(0), track(1, { disposition: { ...disp, default: true } })]).selected).toEqual(['aud-1']);
  });
  it('avoids commentary and audio-description tracks unless nothing else exists', () => {
    const audio = [track(0, { disposition: { ...disp, commentary: true } }), track(1)];
    expect(pick(audio).selected).toEqual(['aud-1']);
    expect(pick([audio[0]!]).selected).toEqual(['aud-0']);
  });
  it('language beats default, default beats commentary, ordinal is the final tie-break', () => {
    const audio = [track(0, { language: 'eng', disposition: { ...disp, default: true } }), track(1, { language: 'hin' }), track(2, { language: 'hin' })];
    expect(pick(audio, 'hi', 3).selected).toEqual(['aud-1', 'aud-2', 'aud-0']);
  });
  it('reports every non-selected track and duplicates instead of dropping them silently', () => {
    const audio = [track(0), track(1, { duplicateOf: 'aud-0', artifact: null }), track(2)];
    expect(pick(audio, null, 1)).toEqual({ selected: ['aud-0'], skipped: [{ id: 'aud-1', reason: 'duplicate' }, { id: 'aud-2', reason: 'not-selected' }] });
  });
  it('allows several tracks and is deterministic', () => {
    const audio = [track(0, { language: 'eng' }), track(1, { language: 'hin' }), track(2, { language: 'spa' })];
    expect(pick(audio, 'auto', 2).selected).toEqual(['aud-0', 'aud-1']);
    expect(pick(audio, 'auto', 2)).toEqual(pick(audio, 'auto', 2));
  });
});
