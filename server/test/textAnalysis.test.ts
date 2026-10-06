import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaResponse, TextAnalysisResponse } from '@/domain/api/contract';
import type { RawTranscription } from '@/domain/speech/normalize';
import { SpeechError, type SpeechRequest, type SpeechToTextProvider } from '../src/application/speechPorts';
import type { TextAnalysisLimits } from '../src/application/textAnalysisService';
import { eventually, fixture, startTestApp, upload, waitForExtraction, waitForTextAnalysis, type TestApp } from './helpers';

let app: TestApp;
afterEach(async () => { await app?.close(); });

const MIME: Record<string, string> = { mkv: 'video/x-matroska', webm: 'video/webm', mp4: 'video/mp4' };
const send = async (file: string) => {
  const { media } = (await (await upload(app, new Uint8Array(fixture(file)), file, MIME[file.split('.').pop()!])).json()) as MediaResponse;
  return media.asset.id;
};

const w = (text: string, start: number, end: number, confidence = 0.9) => ({ text, start, end, confidence });
const HELLO: RawTranscription = {
  language: 'en', wordTiming: 'alignment',
  segments: [
    { start: 0.2, end: 2.6, text: ' Hello, this is a SafeWatch test.', confidence: 0.9, words: [w('Hello,', 0.2, 0.7), w('this', 0.7, 1), w('is', 1, 1.2), w('a', 1.2, 1.4), w('SafeWatch', 1.4, 2.2, 0.7), w('test.', 2.2, 2.6)] },
    { start: 2.7, end: 5.1, text: ' The quick brown fox jumps over the lazy dog.', confidence: 0.95 },
  ],
};

interface Scripted extends SpeechToTextProvider { calls: Array<{ language: string | null; durationSeconds: number; path: string }>; signals: AbortSignal[]; active: number; peak: number }
/** A scripted provider: `reply` decides per call; it records what it was asked. */
function fakeProvider(reply: (call: number, req: SpeechRequest, durationSeconds: number) => Promise<RawTranscription> | RawTranscription = () => HELLO, delayMs = 0): Scripted {
  const p: Scripted = {
    info: { name: 'fake', model: 'fake-model' }, calls: [], signals: [], active: 0, peak: 0,
    isAvailable: async () => true,
    async transcribe(input, req) {
      p.calls.push({ language: req.language, durationSeconds: input.durationSeconds, path: input.file.path });
      p.signals.push(req.signal);
      p.active += 1; p.peak = Math.max(p.peak, p.active);
      try {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return await reply(p.calls.length, req, input.durationSeconds);
      } finally { p.active -= 1; }
    },
  };
  return p;
}
const hang = (_c: number, req: SpeechRequest) => new Promise<RawTranscription>((_res, rej) => req.signal.addEventListener('abort', () => rej(new SpeechError(req.signal.reason === 'timeout' ? 'timeout' : 'cancelled'))));

async function analyse(file: string, provider: SpeechToTextProvider | null, limits: Partial<TextAnalysisLimits> = {}) {
  app = await startTestApp({ extraction: {}, speech: { provider, limits } });
  const id = await send(file);
  return { id, text: await waitForTextAnalysis(app, id) };
}

describe('lifecycle: media READY, extraction COMPLETED, text analysis READY, safety analysis NOT started', () => {
  it('keeps the four states separate and ready never means "safe"', async () => {
    const { id, text } = await analyse('speech-subs.mkv', fakeProvider());
    expect(text).toMatchObject({ status: 'ready', phase: null, mediaId: id, issues: [] });
    const res = (await (await fetch(`${app.url}/api/media/${id}`)).json()) as MediaResponse;
    expect(res.media.asset.status).toBe('ready');
    expect(res.media.extraction.status).toBe('completed');
    expect(res.media.text).toEqual({ status: 'ready', phase: null });
    expect(res.media.analysis).toEqual({ status: 'not_started' });
    expect(JSON.stringify(text)).not.toMatch(/"(safe|score|verdict|risk|blocked)"/i);
  });
  it('is scheduled only after extraction completed, never for failed extraction', async () => {
    app = await startTestApp({ extraction: { limits: { maxFrameBytes: 10 } }, speech: { provider: fakeProvider() } });
    const id = await send('speech-en.mp4');
    expect((await waitForExtraction(app, id)).status).toBe('failed');
    await new Promise((r) => setTimeout(r, 150));
    expect(app.repository.get(id)!.text.status).toBe('not_started');
  });
});

describe('speech + subtitles → one aligned timeline', () => {
  it('transcribes the audio, collects the cues, and marks evidence both / speech-only / subtitle-only', async () => {
    const provider = fakeProvider();
    const { text } = await analyse('speech-subs.mkv', provider);
    expect(text.provider).toEqual({ name: 'fake', model: 'fake-model' });
    expect(text.speech).toHaveLength(1);
    expect(text.speech[0]).toMatchObject({ audioTrackId: 'aud-0', status: 'completed', containerLanguage: 'eng', transcript: { language: 'en', hasWordTimestamps: true, wordTiming: 'alignment' } });
    expect(text.timeline.map((e) => [e.source, e.text, e.evidence])).toEqual([
      ['speech', 'Hello, this is a SafeWatch test.', 'both'],
      ['subtitle', 'Hello, this is a SafeWatch test.', 'both'],
      ['speech', 'The quick brown fox jumps over the lazy dog.', 'both'],
      ['subtitle', 'The quick brown fox jumps over the lazy dog.', 'both'],
      ['subtitle', 'A line that is only written.', 'subtitle-only'],
    ]);
    expect(text.alignment!.counts).toEqual({ both: 4, speechOnly: 0, subtitleOnly: 1 });
    expect(provider.calls).toHaveLength(1);
  });
  it('reports speech with no subtitle corroboration as speech-only', async () => {
    const { text } = await analyse('speech-en.mp4', fakeProvider());
    expect(text.timeline.every((e) => e.source === 'speech' && e.evidence === 'speech-only')).toBe(true);
    expect(text.alignment!.counts).toEqual({ both: 0, speechOnly: 2, subtitleOnly: 0 });
  });
  it('works for subtitle-only media with no audio track at all (provider never called)', async () => {
    const provider = fakeProvider();
    const { text } = await analyse('subs-only.mkv', provider);
    expect(text).toMatchObject({ status: 'ready', speech: [], provider: null });
    expect(text.timeline.map((e) => [e.source, e.evidence])).toEqual([['subtitle', 'subtitle-only'], ['subtitle', 'subtitle-only'], ['subtitle', 'subtitle-only']]);
    expect(provider.calls).toHaveLength(0);
  });
  it('video with no audio and no subtitles is ready with an explicit "no text" warning, not a failure', async () => {
    const { text } = await analyse('sample-silent.webm', fakeProvider());
    expect(text).toMatchObject({ status: 'ready', speech: [], timeline: [], issues: [{ code: 'no-text', stage: 'timeline', fatal: false }] });
  });
  it('image subtitles contribute no text events (they are not text)', async () => {
    const { text } = await analyse('image-subs.mkv', fakeProvider());
    expect(text.timeline.every((e) => e.trackId !== 'sub-0')).toBe(true); // sub-0 is the PGS track
    expect(text.timeline.length).toBeGreaterThan(0);
  });
  it('silence yields an empty but valid transcript (no invented text)', async () => {
    const { text } = await analyse('speech-silence.mp4', fakeProvider(() => ({ language: 'en', segments: [] })));
    expect(text.speech[0]).toMatchObject({ status: 'completed', transcript: { segments: [] } });
    expect(text.timeline).toEqual([]);
  });
});

describe('speech-to-text not configured', () => {
  it('still collects subtitle evidence and lists the audio track as skipped (speech-disabled), never silently', async () => {
    const { text } = await analyse('speech-subs.mkv', null);
    expect(text.status).toBe('ready');
    expect(text.speech).toMatchObject([{ audioTrackId: 'aud-0', status: 'skipped', skipReason: 'speech-disabled', transcript: null }]);
    expect(text.timeline.every((e) => e.source === 'subtitle')).toBe(true);
    expect(text.provider).toBeNull();
  });
});

describe('audio track selection', () => {
  it('transcribes ONE track by default, choosing the container default, and lists the other as not-selected', async () => {
    const provider = fakeProvider();
    const { text } = await analyse('speech-multi.mkv', provider);
    expect(text.speech.map((s) => [s.audioTrackId, s.containerLanguage, s.status, s.skipReason])).toEqual([['aud-0', 'hin', 'completed', null], ['aud-1', 'eng', 'skipped', 'not-selected']]);
  });
  it('honours the configured language as the preferred track and passes it to the provider', async () => {
    const provider = fakeProvider();
    const { text } = await analyse('speech-multi.mkv', provider, { language: 'en' });
    expect(text.speech.find((s) => s.status === 'completed')!.audioTrackId).toBe('aud-1');
    expect(provider.calls[0]!.language).toBe('en');
  });
  it('can transcribe several tracks and keeps each result tied to its stream', async () => {
    const provider = fakeProvider((n) => ({ language: n === 1 ? 'hi' : 'en', segments: [{ start: 0, end: 1, text: n === 1 ? 'पहला' : 'second' }] }));
    const { text } = await analyse('speech-multi.mkv', provider, { maxTracks: 2 });
    expect(text.speech.map((s) => [s.audioTrackId, s.streamIndex, s.status, s.transcript?.language])).toEqual([['aud-0', 1, 'completed', 'hi'], ['aud-1', 2, 'completed', 'en']]);
    expect(text.timeline.map((e) => e.trackId).sort()).toEqual(['aud-0', 'aud-1']);
  });
  it('without a language preference it asks the provider to detect the language', async () => {
    const provider = fakeProvider();
    await analyse('speech-en.mp4', provider);
    expect(provider.calls[0]!.language).toBeNull();
  });
});

describe('failure handling: a track fails, the analysis keeps going and says why', () => {
  it.each(['unavailable', 'unsupported-audio', 'unsupported-language', 'provider-failed', 'invalid-response', 'resource-limit'] as const)('provider error %s → track failed with that code', async (code) => {
    const { text } = await analyse('speech-subs.mkv', fakeProvider(() => { throw new SpeechError(code); }));
    expect(text.status).toBe('ready');
    expect(text.speech[0]).toMatchObject({ status: 'failed', error: code, transcript: null });
    expect(text.issues).toEqual([{ code, stage: 'speech', fatal: false, trackId: 'aud-0' }]);
    expect(text.timeline.every((e) => e.source === 'subtitle')).toBe(true); // subtitle evidence is kept
  });
  it('an unexpected provider exception becomes provider-failed without leaking its message', async () => {
    const { text } = await analyse('speech-en.mp4', fakeProvider(() => { throw new Error('boom at /secret/models/ggml.bin line 5'); }));
    expect(text.speech[0]).toMatchObject({ status: 'failed', error: 'provider-failed' });
    expect(JSON.stringify(text)).not.toMatch(/secret|boom|ggml/);
  });
  it.each([
    ['not an object', null],
    ['no segments array', {}],
    ['segments is not an array', { segments: 'x' }],
  ])('malformed provider response (%s) → invalid-response', async (_n, raw) => {
    const { text } = await analyse('speech-en.mp4', fakeProvider(() => raw as never));
    expect(text.speech[0]).toMatchObject({ status: 'failed', error: 'invalid-response' });
  });
  it('segments with missing or invalid timestamps are dropped and counted, not trusted', async () => {
    const raw: RawTranscription = { language: 'en', segments: [{ start: 0, end: 1, text: 'kept' }, { start: undefined, end: 2, text: 'no start' }, { start: 5, end: 3, text: 'backwards' }, { start: NaN, end: 4, text: 'nan' }] };
    const { text } = await analyse('speech-en.mp4', fakeProvider(() => raw));
    const t = text.speech[0]!.transcript!;
    expect(t.segments.map((s) => s.text)).toEqual(['kept']);
    expect(t.issues).toEqual([{ code: 'invalid-timestamp', count: 3 }]);
  });
  it('rejects audio over the duration or size limits before calling the provider', async () => {
    const provider = fakeProvider();
    const { text } = await analyse('speech-en.mp4', provider, { maxDurationSeconds: 1 });
    expect(text.speech[0]).toMatchObject({ status: 'failed', error: 'resource-limit' });
    expect(provider.calls).toHaveLength(0);
    await app.close();
    const bytes = fakeProvider();
    const r = await analyse('speech-en.mp4', bytes, { maxAudioBytes: 1000 });
    expect(r.text.speech[0]).toMatchObject({ status: 'failed', error: 'resource-limit' });
    expect(bytes.calls).toHaveLength(0);
  });
  it('a provider timeout fails that track, aborts the work (reason "timeout") and cleans up', async () => {
    const provider = fakeProvider(hang);
    const { id, text } = await analyse('speech-subs.mkv', provider, { timeoutMs: 150 });
    expect(text.speech[0]).toMatchObject({ status: 'failed', error: 'timeout' });
    expect(provider.signals[0]!.aborted).toBe(true);
    expect(provider.signals[0]!.reason).toBe('timeout');
    expect(text.issues[0]).toMatchObject({ code: 'timeout', fatal: false });
    expect(provider.active).toBe(0);
    expect(await readdir(join(app.storageDir, `${id}.extraction`))).toEqual(expect.arrayContaining(['audio'])); // media assets untouched; only the speech job failed
  });
  it('a provider crash does not affect the following media', async () => {
    let n = 0;
    const provider = fakeProvider(() => { n += 1; if (n === 1) throw new SpeechError('provider-failed'); return HELLO; });
    app = await startTestApp({ extraction: {}, speech: { provider } });
    const a = await send('speech-en.mp4');
    const b = await send('speech-en.mp4');
    expect((await waitForTextAnalysis(app, a)).speech[0]!.status).toBe('failed');
    expect((await waitForTextAnalysis(app, b)).speech[0]!.status).toBe('completed');
  });
});

describe('cancellation, concurrency and cleanup', () => {
  it('deleting the media aborts an in-flight transcription (reason "cancelled") and leaves nothing on disk', async () => {
    const provider = fakeProvider(hang);
    app = await startTestApp({ extraction: {}, speech: { provider, limits: { timeoutMs: 20_000 } } });
    const id = await send('speech-en.mp4');
    await eventually(() => provider.calls.length === 1);
    await fetch(`${app.url}/api/media/${id}`, { method: 'DELETE' });
    await eventually(() => provider.signals[0]!.aborted);
    expect(provider.signals[0]!.reason).toBe('cancelled');
    await eventually(async () => (await app.files()).length === 0);
    expect(app.repository.get(id)).toBeUndefined();
    expect(provider.active).toBe(0);
  });
  it('runs at most one transcription at a time by default; later media wait in a bounded queue', async () => {
    const provider = fakeProvider(() => HELLO, 120);
    app = await startTestApp({ extraction: { maxConcurrent: 3 }, speech: { provider, maxConcurrent: 1, maxQueued: 5 } });
    const ids = [await send('speech-en.mp4'), await send('speech-en.mp4'), await send('speech-en.mp4')];
    for (const id of ids) expect((await waitForTextAnalysis(app, id)).status).toBe('ready');
    expect(provider.peak).toBe(1);
    expect(provider.calls).toHaveLength(3);
  });
  it('fails text analysis with server-busy (media stays ready) when the speech queue is full', async () => {
    const provider = fakeProvider(hang);
    app = await startTestApp({ extraction: { maxConcurrent: 2 }, speech: { provider, maxConcurrent: 1, maxQueued: 0, limits: { timeoutMs: 500 } } });
    await send('speech-en.mp4');
    await eventually(() => provider.calls.length === 1);
    const second = await send('speech-en.mp4');
    const text = await waitForTextAnalysis(app, second);
    expect(text).toMatchObject({ status: 'failed', issues: [{ code: 'server-busy', stage: 'queue', fatal: true }] });
    expect(app.repository.get(second)!.asset.status).toBe('ready');
  });
  it('gives the provider a path only inside the call, never exposes it, and never logs transcript text', async () => {
    const provider = fakeProvider();
    const { id, text } = await analyse('speech-en.mp4', provider);
    expect(provider.calls[0]!.path).toContain(`${id}.extraction`);
    expect(provider.calls[0]!.path).toMatch(/audio\/aud-0\.wav$/);
    const json = JSON.stringify(text);
    expect(json).not.toContain(app.storageDir);
    expect(json).not.toMatch(/\.wav|\.extraction/);
    expect(JSON.stringify(app.logs)).not.toMatch(/SafeWatch|quick brown fox/);
  });
  it('logs operation, media id, status and duration (no content)', async () => {
    const { id } = await analyse('speech-en.mp4', fakeProvider());
    expect(app.logs.find((l) => l.msg === 'text analysis ready')).toMatchObject({ op: 'text', mediaId: id, status: 'ready', durationMs: expect.any(Number), segments: 2 });
    expect(app.logs.find((l) => l.msg === 'speech track transcribed')).toMatchObject({ op: 'speech', mediaId: id, trackId: 'aud-0', status: 'completed', language: 'en' });
  });
  it('transcripts follow the media lifecycle: expiry and restart purge remove them', async () => {
    app = await startTestApp({ extraction: {}, speech: { provider: fakeProvider() }, retentionMs: 60_000 });
    const id = await send('speech-en.mp4');
    await waitForTextAnalysis(app, id);
    app.clock.now += 61_000;
    await app.service.sweep();
    expect(app.repository.get(id)).toBeUndefined();
    expect((await fetch(`${app.url}/api/media/${id}/transcript`)).status).toBe(404);
    expect(await app.files()).toEqual([]);
  });
});

describe('security: transcript text is untrusted data', () => {
  it('keeps hostile transcript text inert: no markup interpretation, controls and bidi removed, nothing executed', async () => {
    const hostile = '<script>alert(1)</script> <img src=x onerror=alert(1)> $(rm -rf /) `id` ; | && ‮evil‬ \u0000 ../../etc/passwd';
    const { text } = await analyse('speech-en.mp4', fakeProvider(() => ({ language: 'en', segments: [{ start: 0, end: 2, text: hostile, words: [{ start: 0, end: 1, text: '<script>', confidence: 0.5 }] }] })));
    const seg = text.speech[0]!.transcript!.segments[0]!;
    expect(seg.text).toBe('<script>alert(1)</script> <img src=x onerror=alert(1)> $(rm -rf /) `id` ; | && evil ../../etc/passwd');
    expect(seg.originalText).toContain('‮');
    const res = await fetch(`${app.url}/api/media/${text.mediaId}/transcript`);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('a language value from the model is reduced to a safe tag, never trusted as text', async () => {
    const { text } = await analyse('speech-en.mp4', fakeProvider(() => ({ language: '<script>', segments: [{ start: 0, end: 1, text: 'x' }] })));
    expect(text.speech[0]!.transcript!.language).toBeNull();
  });
});

describe('GET /api/media/:id/transcript', () => {
  it('404s for unknown or malformed ids and wrong methods', async () => {
    app = await startTestApp({ extraction: {}, speech: { provider: null } });
    for (const id of ['00000000-0000-4000-8000-000000000000', 'nope', '..%2Fx']) expect((await fetch(`${app.url}/api/media/${id}/transcript`)).status).toBe(404);
    const id = await send('speech-en.mp4');
    expect((await fetch(`${app.url}/api/media/${id}/transcript`, { method: 'POST' })).status).toBe(404);
  });
  it('reports queued/processing states while the provider works, then ready', async () => {
    const provider = fakeProvider(() => HELLO, 400);
    app = await startTestApp({ extraction: {}, speech: { provider } });
    const id = await send('speech-en.mp4');
    const seen = new Set<string>();
    const end = Date.now() + 10_000;
    for (;;) {
      const t = ((await (await fetch(`${app.url}/api/media/${id}/transcript`)).json()) as TextAnalysisResponse).textAnalysis;
      seen.add(`${t.status}:${t.phase}`);
      if (t.status === 'ready' || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toContain('processing:speech-processing');
    expect(seen).toContain('ready:null');
    expect(JSON.stringify([...seen])).not.toMatch(/%|percent/i);
  });
  it('is not_started for media whose extraction has not finished', async () => {
    app = await startTestApp();
    const id = await send('speech-en.mp4');
    const t = ((await (await fetch(`${app.url}/api/media/${id}/transcript`)).json()) as TextAnalysisResponse).textAnalysis;
    expect(t).toMatchObject({ status: 'not_started', speech: [], timeline: [], alignment: null });
  });
  it('can omit word timestamps (?words=false) to keep the payload small', async () => {
    const { id, text } = await analyse('speech-subs.mkv', fakeProvider());
    expect(text.speech[0]!.transcript!.segments[0]!.words).not.toBeNull();
    const slim = ((await (await fetch(`${app.url}/api/media/${id}/transcript?words=false`)).json()) as TextAnalysisResponse).textAnalysis;
    expect(slim.speech[0]!.transcript!.segments.every((s) => s.words === null)).toBe(true);
    expect(slim.timeline.every((e) => e.words === null)).toBe(true);
    expect(slim.timeline).toHaveLength(text.timeline.length);
  });
  it('never exposes model paths, provider command lines, credentials or stack traces', async () => {
    const { text } = await analyse('speech-subs.mkv', fakeProvider(() => { throw new Error('/Users/me/models/ggml-base.bin API_KEY=sk-secret at stack.js:1'); }));
    expect(JSON.stringify(text)).not.toMatch(/Users|ggml|API_KEY|sk-secret|stack|\.js/);
  });
});

describe('health', () => {
  it('reports speech provider availability only (no model or path)', async () => {
    app = await startTestApp({ extraction: {}, speech: { provider: fakeProvider() } });
    const body = (await (await fetch(`${app.url}/api/health`)).json()) as { speech: unknown };
    expect(body.speech).toEqual({ provider: 'test', available: true });
  });
});
