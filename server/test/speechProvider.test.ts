import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeTranscription } from '@/domain/speech/normalize';
import { SpeechError } from '../src/application/speechPorts';
import { WhisperCppProvider, parseWhisperCppJson } from '../src/infrastructure/speech/whisperCppProvider';
import { fixture } from './helpers';

const sample = () => JSON.parse(fixture('whisper-cpp-dtw-sample.json').toString('utf8')) as unknown;

describe('parseWhisperCppJson (real whisper.cpp output captured with DTW)', () => {
  it('maps segments, language and token probabilities; special tokens are ignored', () => {
    const raw = parseWhisperCppJson(sample(), { wordTiming: 'alignment' });
    expect(raw.language).toBe('en');
    expect(raw.wordTiming).toBe('alignment');
    expect(raw.segments).toHaveLength(2);
    expect(raw.segments[0]).toMatchObject({ start: 0, end: 4.6, text: ' The first sentence is right here.' });
    expect(raw.segments[0]!.words!.map((w) => w.text)).toEqual(['The', 'first', 'sentence', 'is', 'right', 'here.']);
    expect(JSON.stringify(raw)).not.toContain('[_BEG_]');
  });
  it('alignment timing: a word starts at its aligned time and ends at the next word start; the last word is capped', () => {
    const [seg1, seg2] = parseWhisperCppJson(sample(), { wordTiming: 'alignment' }).segments;
    const w = seg1!.words!;
    expect(w[0]).toMatchObject({ text: 'The', start: 2.08, end: 2.4 });
    expect(w[1]).toMatchObject({ text: 'first', start: 2.4, end: 3.24 });
    expect(w[5]).toMatchObject({ text: 'here.', start: 3.56 });
    expect(w[5]!.end).toBeLessThanOrEqual(3.56 + 1.0 + 1e-9);
    expect(seg2!.words![0]).toMatchObject({ text: 'The', start: 5.4 });
  });
  it('decoder timing keeps the engine token offsets', () => {
    const raw = parseWhisperCppJson(sample(), { wordTiming: 'decoder' });
    expect(raw.wordTiming).toBe('decoder');
    expect(raw.segments[0]!.words![0]).toMatchObject({ text: 'The', start: 0, end: 0.44 });
  });
  it('averages token probabilities into word and segment confidence (0..1), never inventing them', () => {
    const raw = parseWhisperCppJson(sample(), { wordTiming: 'alignment' });
    for (const s of raw.segments) {
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
    const noProb = { transcription: [{ offsets: { from: 0, to: 1000 }, text: ' hi', tokens: [{ text: ' hi', offsets: { from: 0, to: 1000 }, t_dtw: -1 }] }], result: { language: 'en' } };
    const r = parseWhisperCppJson(noProb);
    expect(r.segments[0]!.confidence).toBeUndefined();
    expect(r.segments[0]!.words![0]!.confidence).toBeUndefined();
  });
  it('falls back to decoder offsets for tokens with no alignment time', () => {
    const doc = { transcription: [{ offsets: { from: 0, to: 2000 }, text: ' a b', tokens: [{ text: ' a', offsets: { from: 100, to: 500 }, p: 0.9, t_dtw: -1 }, { text: ' b', offsets: { from: 600, to: 900 }, p: 0.8, t_dtw: 70 }] }], result: { language: 'en' } };
    const w = parseWhisperCppJson(doc, { wordTiming: 'alignment' }).segments[0]!.words!;
    expect(w[0]).toMatchObject({ start: 0.1 }); // no t_dtw → decoder start
    expect(w[1]).toMatchObject({ start: 0.7 });
  });
  it('the result normalises into a valid SafeWatch transcript', () => {
    const t = normalizeTranscription(parseWhisperCppJson(sample(), { wordTiming: 'alignment' }), { mediaId: 'm', audioTrackId: 'aud-0', streamIndex: 1, durationSeconds: 8, provider: { name: 'whisper.cpp', model: 'ggml-base' } });
    expect(t).toMatchObject({ language: 'en', hasWordTimestamps: true, wordTiming: 'alignment' });
    expect(t.segments.map((s) => s.text)).toEqual(['The first sentence is right here.', 'The second sentence comes after a pause.']);
  });
  it.each([null, undefined, 'x', 5, [], {}, { transcription: 'no' }])('rejects malformed document %j as invalid-response', (doc) => {
    expect(() => parseWhisperCppJson(doc)).toThrow(SpeechError);
    try { parseWhisperCppJson(doc); } catch (e) { expect((e as SpeechError).code).toBe('invalid-response'); }
  });
  it('passes missing or malformed timestamps through for the domain to reject (segments become invalid-timestamp)', () => {
    const doc = { transcription: [{ text: 'no offsets' }, { offsets: { from: 'a', to: 'b' }, text: 'bad', tokens: [] }, { offsets: { from: 0, to: 1000 }, text: ' ok', tokens: [] }], result: {} };
    const t = normalizeTranscription(parseWhisperCppJson(doc), { mediaId: 'm', audioTrackId: 'a', streamIndex: 1, durationSeconds: 5, provider: { name: 'x', model: 'y' } });
    expect(t.segments.map((s) => s.text)).toEqual(['ok']);
    expect(t.issues).toEqual([{ code: 'invalid-timestamp', count: 2 }]);
  });
});

/** Writes an executable Node script that stands in for the whisper.cpp binary, to exercise failure modes deterministically. */
async function fakeBinary(dir: string, body: string): Promise<string> {
  const path = join(dir, 'fake-whisper');
  await writeFile(path, `#!/usr/bin/env node\nconst fs=require('fs');\nconst a=process.argv.slice(2);\nconst arg=(n)=>a[a.indexOf(n)+1];\nif (a.includes('--help')) process.exit(0);\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}
const okJson = JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1500 }, text: ' hello world', tokens: [{ text: ' hello', offsets: { from: 0, to: 600 }, p: 0.9, t_dtw: 5 }, { text: ' world', offsets: { from: 700, to: 1500 }, p: 0.8, t_dtw: 80 }] }] });

describe('WhisperCppProvider (fake engine binary: failure modes)', () => {
  let dir: string;
  let model: string;
  let scratch: string; // private temp root: other test files create their own engine temp dirs in parallel
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sw-fakewhisper-')); scratch = await mkdtemp(join(tmpdir(), 'sw-scratch-')); model = join(dir, 'ggml-base.bin'); await writeFile(model, 'not a real model'); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); });

  const provider = (bin: string, extra: Partial<ConstructorParameters<typeof WhisperCppProvider>[0]> = {}) => new WhisperCppProvider({ binaryPath: bin, modelPath: model, modelName: 'ggml-base', threads: 2, tempRoot: scratch, ...extra });
  const input = { file: { path: '/audio/server-generated.wav' }, durationSeconds: 2 };
  const req = (language: string | null = null, signal = new AbortController().signal) => ({ language, signal });
  const tmpLeftovers = async () => (await readdir(scratch)).filter((n) => n.startsWith('sw-whisper-'));

  it('returns the parsed result on success and passes only controlled arguments', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(arg('-of')+'.json', ${JSON.stringify(okJson)}); fs.writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(a));`);
    const raw = await provider(bin).transcribe(input, req('en'));
    expect(raw.language).toBe('en');
    expect(raw.segments).toHaveLength(1);
    const argv = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[];
    expect(argv.slice(0, 6)).toEqual(['-m', model, '-f', '/audio/server-generated.wav', '-l', 'en']);
    expect(argv).toEqual(expect.arrayContaining(['-ojf', '-np', '-dtw', 'base', '-nfa']));
    expect(argv).not.toContain('-tr'); // never translates
  });
  it('detects the language automatically when none is forced', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(${JSON.stringify(join(dir, 'l.txt'))}, arg('-l')); fs.writeFileSync(arg('-of')+'.json', ${JSON.stringify(okJson)});`);
    await provider(bin).transcribe(input, req(null));
    expect(await readFile(join(dir, 'l.txt'), 'utf8')).toBe('auto');
  });
  it('omits DTW flags when the model name has no known preset or alignment is disabled', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(a)); fs.writeFileSync(arg('-of')+'.json', ${JSON.stringify(okJson)});`);
    await provider(bin, { modelName: 'custom-model' }).transcribe(input, req());
    expect(await readFile(join(dir, 'argv.json'), 'utf8')).not.toContain('-dtw');
    const raw = await provider(bin, { wordTiming: 'decoder' }).transcribe(input, req());
    expect(raw.wordTiming).toBe('decoder');
  });
  it('rejects language values that could be anything but a language code (no injection through arguments)', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(arg('-of')+'.json', ${JSON.stringify(okJson)});`);
    for (const bad of ['en; rm -rf /', '../../x', '--translate', 'EN', 'english', '']) {
      await expect(provider(bin).transcribe(input, req(bad))).rejects.toMatchObject({ code: 'unsupported-language' });
    }
  });
  it.each([
    ['exit 2 (audio could not be read)', `process.exit(2)`, 'unsupported-audio'],
    ['exit 0 but no output file', `process.exit(0)`, 'unsupported-audio'],
    ['exit 3 (model failure)', `process.exit(3)`, 'provider-failed'],
    ['crash (non-zero)', `process.kill(process.pid, 'SIGKILL')`, 'provider-failed'],
    ['malformed JSON', `fs.writeFileSync(arg('-of')+'.json', '{ not json')`, 'invalid-response'],
    ['JSON of the wrong shape', `fs.writeFileSync(arg('-of')+'.json', '{"hello":1}')`, 'invalid-response'],
  ])('%s → %s', async (_name, body, code) => {
    const bin = await fakeBinary(dir, body);
    await expect(provider(bin).transcribe(input, req())).rejects.toMatchObject({ name: 'SpeechError', code });
  });
  it('rejects oversized provider output', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(arg('-of')+'.json', ${JSON.stringify(okJson)});`);
    await expect(provider(bin, { maxOutputBytes: 10 }).transcribe(input, req())).rejects.toMatchObject({ code: 'resource-limit' });
  });
  it('never leaks engine output, paths or stack traces through errors', async () => {
    const bin = await fakeBinary(dir, `console.error('FATAL /secret/model/path stack at foo.js:1'); console.log('secret stdout'); process.exit(3)`);
    const err = await provider(bin).transcribe(input, req()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(SpeechError);
    expect(JSON.stringify([(err as Error).message, (err as Error).stack?.split('\n')[0]])).not.toMatch(/secret|foo\.js|model\/path/);
  });
  it('aborts a hung engine on timeout: the process is killed and its temp directory removed', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid)); setInterval(()=>{}, 1000);`);
    expect(await tmpLeftovers()).toEqual([]);
    const ac = new AbortController();
    // Abort only once the engine is really running (it writes its pid first), so the test does not depend on start-up speed.
    void (async () => { while (!(await readdir(dir)).includes('pid')) await new Promise((r) => setTimeout(r, 10)); ac.abort('timeout'); })();
    await expect(provider(bin).transcribe(input, req(null, ac.signal))).rejects.toMatchObject({ code: 'timeout' });
    const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow(); // no zombie inference process
    expect(await tmpLeftovers()).toEqual([]);
  });
  it('reports cancellation distinctly from timeout', async () => {
    const bin = await fakeBinary(dir, `setInterval(()=>{}, 1000);`);
    const ac = new AbortController();
    setTimeout(() => ac.abort('cancelled'), 600);
    await expect(provider(bin).transcribe(input, req(null, ac.signal))).rejects.toMatchObject({ code: 'cancelled' });
    const done = new AbortController(); done.abort('cancelled');
    await expect(provider(bin).transcribe(input, req(null, done.signal))).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('is unavailable when the binary or model is missing, and says so as a SpeechError', async () => {
    expect(await provider('/no/such/binary').isAvailable()).toBe(false);
    expect(await provider(await fakeBinary(dir, 'process.exit(0)'), { modelPath: join(dir, 'missing.bin') }).isAvailable()).toBe(false);
    await expect(provider('/no/such/binary').transcribe(input, req())).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('keeps the engine output directory private (mode 0700) while the engine runs', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(${JSON.stringify(join(dir, 'mode.txt'))}, String(fs.statSync(require('path').dirname(arg('-of'))).mode & 0o777)); fs.writeFileSync(arg('-of')+'.json', ${JSON.stringify(okJson)});`);
    await provider(bin).transcribe(input, req());
    expect(Number(await readFile(join(dir, 'mode.txt'), 'utf8'))).toBe(0o700);
  });
  it('sweeps stale engine temp directories left by a crash, and only those', async () => {
    const { mkdir, utimes } = await import('node:fs/promises');
    const stale = join(scratch, 'sw-whisper-STALE'); const fresh = join(scratch, 'sw-whisper-FRESH'); const other = join(scratch, 'someone-elses');
    for (const d of [stale, fresh, other]) { await mkdir(d); await writeFile(join(d, 'out.json'), '{"transcript":"private"}'); }
    const old = new Date(Date.now() - 3 * 3600_000);
    await utimes(stale, old, old); await utimes(other, old, old);
    expect(await provider('/unused').cleanupStale(3600_000)).toBe(1);
    expect((await readdir(scratch)).sort()).toEqual(['someone-elses', 'sw-whisper-FRESH']);
  });
  it('removes its temp directory after success and after failure', async () => {
    expect(await tmpLeftovers()).toEqual([]);
    const ok = await fakeBinary(dir, `fs.writeFileSync(arg('-of')+'.json', ${JSON.stringify(okJson)});`);
    await provider(ok).transcribe(input, req());
    const bad = await fakeBinary(dir, `fs.writeFileSync(arg('-of')+'.json', 'x'); process.exit(3)`);
    await provider(bad).transcribe(input, req()).catch(() => undefined);
    expect(await tmpLeftovers()).toEqual([]);
  });
});
