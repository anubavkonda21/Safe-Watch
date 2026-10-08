import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeObservation } from '@/domain/vision/observation';
import { VisionError } from '../src/application/visualPorts';
import { AppleVisionProvider, parseAppleVisionJson } from '../src/infrastructure/vision/appleVisionProvider';
import { fixture } from './helpers';

/** Real output of the safewatch-vision helper (skier photo, rendered text frame, corrupt JPEG), captured once. */
const sample = () => JSON.parse(fixture('apple-vision-sample.json').toString('utf8')) as unknown;
const frames = [{ frameId: 'frm-00000', path: '/a.jpg' }, { frameId: 'frm-00001', path: '/b.jpg' }, { frameId: 'frm-00002', path: '/c.jpg' }];

describe('parseAppleVisionJson (real helper output)', () => {
  it('maps classifications, a person box and OCR text per frame, matched by position', () => {
    const [skier, text, corrupt] = parseAppleVisionJson(sample(), frames);
    expect(skier).toMatchObject({ frameId: 'frm-00000', error: null, width: 640, height: 425 });
    expect(skier!.observations.map((o) => `${o.type}:${o.label}`)).toContain('classification:skiing');
    const person = skier!.observations.find((o) => o.label === 'person')!;
    expect(person.type).toBe('object');
    expect(person.region).toBeTruthy();
    expect(text!.observations.find((o) => o.type === 'text')).toMatchObject({ label: 'text', text: 'SAFEWATCH VISUAL TEST 2026' });
    expect(corrupt).toMatchObject({ frameId: 'frm-00002', error: 'invalid-frame', observations: [] });
  });
  it('every mapped observation survives domain normalisation with a valid top-left region', () => {
    const ctx = { frameId: 'f', frameIndex: 0, timestampSeconds: 1, provider: 'apple-vision', model: 'vision-framework' };
    for (const r of parseAppleVisionJson(sample(), frames)) {
      r.observations.forEach((raw, i) => {
        const n = normalizeObservation(raw, ctx, i);
        expect(n.issues).toEqual([]);
        expect(n.observation).not.toBeNull();
      });
    }
  });
  it('a frame the helper did not report becomes an isolated inference failure', () => {
    const doc = { provider: 'apple-vision', frames: [{ index: 0, ok: true, width: 1, height: 1, observations: [] }] };
    expect(parseAppleVisionJson(doc, frames).map((r) => r.error)).toEqual([null, 'inference-failed', 'inference-failed']);
  });
  it('maps helper failure codes and treats unknown ones as inference failures', () => {
    const doc = { provider: 'apple-vision', frames: [{ index: 0, ok: false, error: 'decode-failed' }, { index: 1, ok: false, error: 'inference-failed' }, { index: 2, ok: false, error: 'weird' }] };
    expect(parseAppleVisionJson(doc, frames).map((r) => r.error)).toEqual(['invalid-frame', 'inference-failed', 'inference-failed']);
  });
  it.each([null, undefined, 'x', 5, [], {}, { provider: 'other', frames: [] }, { provider: 'apple-vision' }, { provider: 'apple-vision', frames: 'no' }])('rejects malformed document %j as invalid-response', (doc) => {
    expect(() => parseAppleVisionJson(doc, frames)).toThrow(VisionError);
    try { parseAppleVisionJson(doc, frames); } catch (e) { expect((e as VisionError).code).toBe('invalid-response'); }
  });
  it('ignores junk entries instead of crashing', () => {
    const doc = { provider: 'apple-vision', frames: [1, null, 'x', { index: 'a' }, { index: 0, ok: true, width: NaN, observations: [5, null, { type: 'object', label: 'person' }] }] };
    const [first] = parseAppleVisionJson(doc, frames);
    expect(first).toMatchObject({ error: null, width: null });
    expect(first!.observations).toHaveLength(1);
  });
});

/** An executable Node script standing in for the helper, to exercise failure modes deterministically. */
async function fakeBinary(dir: string, body: string): Promise<string> {
  const path = join(dir, 'fake-vision');
  await writeFile(path, `#!/usr/bin/env node\nconst fs=require('fs');\nconst a=process.argv.slice(2);\nif (a.includes('--help')) process.exit(0);\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}
const okDoc = JSON.stringify({ provider: 'apple-vision', frames: [{ index: 0, ok: true, width: 10, height: 10, elapsedMs: 3, observations: [{ type: 'classification', label: 'outdoor', confidence: 0.9 }] }] });
const req = (signal = new AbortController().signal) => ({ signal, minConfidence: 0.1, maxLabelsPerFrame: 8 });
const one = [{ frameId: 'frm-00000', path: '/server/generated/frame.jpg' }];

describe('AppleVisionProvider (fake helper: failure modes)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sw-fakevision-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const provider = (bin: string, extra: { maxOutputBytes?: number } = {}) => new AppleVisionProvider({ binaryPath: bin, ...extra });

  it('returns parsed results and passes frame paths only after `--`, as separate arguments', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(${JSON.stringify(join(dir, 'argv.json'))}, JSON.stringify(a)); console.log(${JSON.stringify(okDoc)});`);
    const results = await provider(bin).analyze([{ frameId: 'frm-00000', path: '/x/--evil; rm -rf $HOME.jpg' }], req());
    expect(results[0]!.observations).toHaveLength(1);
    const argv = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[];
    expect(argv).toEqual(['--min-confidence', '0.1', '--max-labels', '8', '--', '/x/--evil; rm -rf $HOME.jpg']);
  });
  it('does nothing for an empty batch', async () => {
    expect(await provider('/does/not/exist').analyze([], req())).toEqual([]);
  });
  it('is unavailable when the binary is missing or not runnable', async () => {
    expect(await provider(join(dir, 'missing')).isAvailable()).toBe(false);
    await expect(provider(join(dir, 'missing')).analyze(one, req())).rejects.toMatchObject({ name: 'VisionError', code: 'provider-unavailable' });
    const notExec = join(dir, 'plain');
    await writeFile(notExec, 'x');
    expect(await provider(notExec).isAvailable()).toBe(false);
  });
  it.each([
    ['non-zero exit', `process.exit(3)`, 'inference-failed'],
    ['crash', `process.kill(process.pid, 'SIGKILL')`, 'inference-failed'],
    ['malformed JSON', `console.log('{ nope')`, 'invalid-response'],
    ['empty output', `process.exit(0)`, 'invalid-response'],
    ['JSON of the wrong shape', `console.log('{"hello":1}')`, 'invalid-response'],
  ])('%s → %s', async (_n, body, code) => {
    const bin = await fakeBinary(dir, body);
    await expect(provider(bin).analyze(one, req())).rejects.toMatchObject({ name: 'VisionError', code });
  });
  it('rejects oversized output without buffering it', async () => {
    const bin = await fakeBinary(dir, `console.log('x'.repeat(100000))`);
    await expect(provider(bin, { maxOutputBytes: 1000 }).analyze(one, req())).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('never leaks engine output, paths or stack traces through errors', async () => {
    const bin = await fakeBinary(dir, `console.error('FATAL /secret/model/path stack at foo.js:1'); console.log('secret stdout'); process.exit(3)`);
    const err = await provider(bin).analyze(one, req()).catch((e: Error) => e);
    expect(err).toBeInstanceOf(VisionError);
    expect(JSON.stringify([(err as Error).message, (err as Error).stack?.split('\n')[0]])).not.toMatch(/secret|foo\.js|model\/path/);
  });
  it('kills a hung helper on timeout and on cancellation, with distinct codes', async () => {
    const bin = await fakeBinary(dir, `fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))}, String(process.pid)); setInterval(()=>{}, 1000);`);
    for (const reason of ['timeout', 'cancelled'] as const) {
      await rm(join(dir, 'pid'), { force: true });
      const c = new AbortController();
      const p = provider(bin).analyze(one, req(c.signal));
      // Abort only once the helper has really started (it writes its pid first).
      const started = (async () => { for (let i = 0; i < 200; i++) { if (await readFile(join(dir, 'pid'), 'utf8').then((t) => t.length > 0, () => false)) break; await new Promise((r) => setTimeout(r, 25)); } c.abort(reason); })();
      await started;
      await expect(p).rejects.toMatchObject({ code: reason });
      const pid = Number(await readFile(join(dir, 'pid'), 'utf8'));
      await new Promise((r) => setTimeout(r, 100));
      expect(() => process.kill(pid, 0)).toThrow(); // the process is gone
    }
  });
  it('refuses to start when already aborted', async () => {
    const bin = await fakeBinary(dir, `console.log(${JSON.stringify(okDoc)})`);
    const c = new AbortController();
    c.abort('cancelled');
    await expect(provider(bin).analyze(one, req(c.signal))).rejects.toMatchObject({ code: 'cancelled' });
  });
});
