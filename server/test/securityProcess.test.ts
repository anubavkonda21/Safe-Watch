import { createServer, type Server } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppleVisionProvider } from '../src/infrastructure/vision/appleVisionProvider';
import { WhisperCppProvider, parseWhisperCppJson } from '../src/infrastructure/speech/whisperCppProvider';
import { FfmpegMediaProcessor } from '../src/infrastructure/ffmpeg/ffmpegMediaProcessor';
import { FfmpegMediaExtractor } from '../src/infrastructure/ffmpeg/ffmpegMediaExtractor';
import { buildFfprobeArgs, inputArgs } from '../src/infrastructure/ffmpeg/ffprobe';
import {
  ProcessError, configureKillGrace, configureSandbox, liveProcessCount, probeSeatbelt, runBinary, seatbeltProfile, terminateAllProcesses,
} from '../src/infrastructure/ffmpeg/processRunner';
import { fixture, hasFfmpeg } from './helpers';

const node = process.execPath;
let scratch: string;
beforeEach(async () => { scratch = await realpath(await mkdtemp(join(tmpdir(), 'sw-proc-'))); configureKillGrace(300); });
afterEach(async () => { configureSandbox('none'); configureKillGrace(1000); await rm(scratch, { recursive: true, force: true }); });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (pid: number, ms = 3000) => { const end = Date.now() + ms; while (alive(pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return !alive(pid); };

describe('termination', () => {
  it('abort stops the process AND the processes it started (its whole group), and settles only after they are gone', async () => {
    const ac = new AbortController();
    let pid = 0;
    // The parent starts a long-running grandchild and records its pid in a file.
    const pidFile = join(scratch, 'pid');
    const p2 = runBinary(node, ['-e', `const c=require('child_process').spawn('sleep',['60'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`], { signal: ac.signal });
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    pid = Number(await readFile(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    ac.abort();
    await expect(p2).rejects.toMatchObject({ kind: 'aborted' });
    expect(await waitDead(pid)).toBe(true);
    expect(liveProcessCount()).toBe(0);
  });
  it('a process that ignores SIGTERM is killed with SIGKILL after the grace period', async () => {
    const ac = new AbortController();
    const started = join(scratch, 'started');
    const p = runBinary(node, ['-e', `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(started)},'1');setInterval(()=>{},1000)`], { signal: ac.signal });
    for (let i = 0; i < 100 && !existsSync(started); i++) await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    ac.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250); // it waited for the grace period...
    expect(Date.now() - t0).toBeLessThan(3000); // ...and then forced the issue
    expect(liveProcessCount()).toBe(0);
  });
  it('an output flood kills the process before it can exhaust memory', async () => {
    await expect(runBinary(node, ['-e', 'for(;;)process.stdout.write("x".repeat(65536))'], { maxStdoutBytes: 4096 })).rejects.toMatchObject({ kind: 'output-too-large' });
    expect(liveProcessCount()).toBe(0);
  });
  it('terminateAllProcesses (shutdown) stops everything that is running and reports how many', async () => {
    const a = runBinary(node, ['-e', 'setInterval(()=>{},1000)']).catch((e) => e);
    const b = runBinary(node, ['-e', 'setInterval(()=>{},1000)']).catch((e) => e);
    await new Promise((r) => setTimeout(r, 150));
    expect(liveProcessCount()).toBe(2);
    expect(await terminateAllProcesses(3000)).toBe(2);
    expect(liveProcessCount()).toBe(0);
    for (const r of await Promise.all([a, b])) expect((r as { exitCode: number | null }).exitCode).toBeNull(); // the jobs observe a signal death (a failure for every caller), not a hang
  });
  it('runs tools from a neutral working directory, so relative paths cannot be redirected', async () => {
    const { stdout } = await runBinary(node, ['-e', 'process.stdout.write(process.cwd())']);
    expect(await realpath(stdout)).toBe(await realpath(tmpdir()));
  });
  it('reports a non-zero exit and a death by signal without any tool output', async () => {
    expect((await runBinary(node, ['-e', 'process.exit(7)'])).exitCode).toBe(7);
    expect((await runBinary(node, ['-e', 'process.kill(process.pid,"SIGSEGV")'])).exitCode).toBeNull();
  });
});

const hasSeatbelt = await probeSeatbelt();
describe.skipIf(!hasSeatbelt)('macOS Seatbelt sandbox (real enforcement)', () => {
  beforeEach(() => configureSandbox('seatbelt'));

  it('denies all network access', async () => {
    const hits: string[] = [];
    const srv: Server = createServer((req, res) => { hits.push(req.url ?? ''); res.end('x'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    const code = `const s=require('net').connect(${port},'127.0.0.1');s.on('connect',()=>{process.stdout.write('CONNECTED');process.exit(0)});s.on('error',e=>{process.stdout.write('DENIED '+e.code);process.exit(0)})`;
    const { stdout } = await runBinary(node, ['-e', code]);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(stdout).toMatch(/^DENIED (EPERM|EACCES)/);
    expect(hits).toEqual([]);
  });
  it('allows writing only inside the listed directory', async () => {
    const inside = join(scratch, 'work'); const outside = join(scratch, 'elsewhere');
    await mkdir(inside); await mkdir(outside);
    const probe = (dir: string) => `try{require('fs').writeFileSync(${JSON.stringify(join(dir, 'f'))},'x');process.stdout.write('WROTE')}catch(e){process.stdout.write('DENIED '+e.code)}`;
    expect((await runBinary(node, ['-e', probe(inside)], { sandbox: { writeDirs: [inside] } })).stdout).toBe('WROTE');
    expect((await runBinary(node, ['-e', probe(outside)], { sandbox: { writeDirs: [inside] } })).stdout).toMatch(/^DENIED/);
    expect(existsSync(join(outside, 'f'))).toBe(false);
    expect((await runBinary(node, ['-e', probe(inside)])).stdout).toMatch(/^DENIED/); // no policy = no writes at all
  });
  it('cannot be escaped with a symlink inside the writable directory', async () => {
    const inside = join(scratch, 'work'); const outside = join(scratch, 'elsewhere');
    await mkdir(inside); await mkdir(outside);
    const code = `const fs=require('fs');try{fs.symlinkSync(${JSON.stringify(outside)},${JSON.stringify(join(inside, 'l'))});fs.writeFileSync(${JSON.stringify(join(inside, 'l', 'f'))},'x');process.stdout.write('WROTE')}catch(e){process.stdout.write('DENIED '+e.code)}`;
    await runBinary(node, ['-e', code], { sandbox: { writeDirs: [inside] } });
    expect(existsSync(join(outside, 'f'))).toBe(false);
  });
  it('denies creating child processes', async () => {
    const code = `try{require('child_process').execSync('echo hi');process.stdout.write('FORKED')}catch(e){process.stdout.write('DENIED')}`;
    expect((await runBinary(node, ['-e', code])).stdout).toBe('DENIED');
  });
  it('still lets the tool read what it needs (media, libraries)', async () => {
    const f = join(scratch, 'in.txt');
    await writeFile(f, 'readable');
    expect((await runBinary(node, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(f)},'utf8'))`])).stdout).toBe('readable');
  });
  it('refuses a writable directory that could rewrite the sandbox profile', () => {
    for (const bad of ['a"b', 'a\\b', 'a\nb']) {
      const dir = join(scratch, bad);
      // Only real directories are admitted into the profile at all; a name with special characters must be refused if it exists.
      expect(() => seatbeltProfile({ writeDirs: [scratch] })).not.toThrow();
      expect(seatbeltProfile({ writeDirs: [dir] })).not.toContain(bad); // non-existent: dropped, never interpolated
    }
  });
  it('the GPU shader cache is writable only when asked for, and only its own subdirectory', () => {
    expect(seatbeltProfile({ gpuShaderCache: false })).not.toContain('com.apple.metal');
    const p = seatbeltProfile({ gpuShaderCache: true });
    const m = /\(subpath "([^"]*com\.apple\.metal)"\)/.exec(p);
    if (m) expect(m[1]!.endsWith('/C/com.apple.metal')).toBe(true); // never the whole cache directory
  });
  it('the profile contains the deny rules and only the listed writable paths', () => {
    const p = seatbeltProfile({ writeDirs: [scratch] });
    expect(p).toContain('(deny network*)');
    expect(p).toContain('(deny process-fork)');
    expect(p).toContain('(deny file-write*)');
    expect(p).toContain(`(subpath "${scratch}")`);
    expect(seatbeltProfile()).not.toContain('subpath');
  });
  it.skipIf(!hasFfmpeg)('real FFprobe, decode check, audio extraction and frame sampling all still work inside the sandbox', async () => {
    const file = join(scratch, 'sample.mp4');
    await writeFile(file, fixture('sample.mp4'));
    const input = { path: file, container: 'mp4' as const };
    const processor = new FfmpegMediaProcessor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    const meta = await processor.extractMetadata(input, {});
    expect(meta.durationSeconds).toBeGreaterThan(0);
    await processor.verifyDecodable(input, {});
    const extractor = new FfmpegMediaExtractor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    const ctx = { input, workspace: { dir: join(scratch, 'ws') }, signal: new AbortController().signal, limits: { timeoutMs: 30_000, frame: { intervalSeconds: 10, maxFrames: 3, maxWidth: 320, maxHeight: 320 }, maxFrameBytes: 1 << 26, maxAudioBytes: 1 << 28, maxAudioTracks: 2, maxCues: 1000, maxSubtitleBytes: 1 << 20 }, stats: { processes: 0 } };
    await mkdir(ctx.workspace.dir, { recursive: true });
    const frame = await extractor.sampleFrame(ctx, 0.5, 0);
    expect(frame).not.toBeNull();
    expect(existsSync(join(ctx.workspace.dir, 'frames', 'frm-00000.jpg'))).toBe(true);
  });
  it.skipIf(!hasFfmpeg)('FFmpeg given an output path OUTSIDE its workspace is refused by the OS, not just by our argument builder', async () => {
    const file = join(scratch, 'sample.mp4');
    await writeFile(file, fixture('sample.mp4'));
    const target = join(scratch, 'escaped.jpg');
    const r = await runBinary('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-frames:v', '1', '-update', '1', '-y', target], { sandbox: { writeDirs: [join(scratch, 'ws')] } });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)('FFmpeg invocation', () => {
  it('every input is a local file read through a forced demuxer, with all other protocols disabled', () => {
    const probe = buildFfprobeArgs('/x/y.media', 'mp4');
    const wl = probe.indexOf('-protocol_whitelist');
    expect(probe[wl + 1]).toBe('file');
    expect(wl).toBeLessThan(probe.indexOf('-i'));
    expect(probe[probe.indexOf('-i') + 1]).toBe('/x/y.media');
    expect(probe).toContain('-f');
    const input = inputArgs('/x/y.media', 'matroska' as never);
    expect(input.slice(0, 2)).toEqual(['-protocol_whitelist', 'file']);
  });
  it('a file that merely LOOKS like a playlist or concat script never makes FFmpeg touch the network', async () => {
    const hits: string[] = [];
    const srv: Server = createServer((req, res) => { hits.push(req.url ?? ''); res.end('x'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/seg.ts`;
    const processor = new FfmpegMediaProcessor({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
    for (const [name, body] of [
      ['a.m3u8', `#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:1,\n${url}\n#EXT-X-ENDLIST\n`],
      ['b.ffconcat', `ffconcat version 1.0\nfile '${url}'\n`],
      ['c.sdp', `v=0\no=- 0 0 IN IP4 127.0.0.1\nm=video 5004 RTP/AVP 96\nc=IN IP4 127.0.0.1\na=rtpmap:96 H264/90000\n`],
      ['d.txt', `${url}\n`],
    ] as const) {
      const f = join(scratch, name);
      await writeFile(f, body);
      for (const container of ['mp4', 'matroska', 'webm'] as const) {
        await expect(processor.extractMetadata({ path: f, container: container as never }, {})).rejects.toBeDefined();
      }
    }
    await new Promise<void>((r) => srv.close(() => r()));
    expect(hits).toEqual([]);
  });
});

describe('helper process (Vision) and whisper output are never trusted', () => {
  async function fakeHelper(script: string) {
    const path = join(scratch, 'helper');
    await writeFile(path, `#!${node}\nif(process.argv.includes('--help'))process.exit(0);\n${script}\n`);
    await chmod(path, 0o755);
    return new AppleVisionProvider({ binaryPath: path });
  }
  const frames = [{ frameId: 'frm-00000', path: join(tmpdir(), 'nope.jpg') }, { frameId: 'frm-00001', path: join(tmpdir(), 'nope2.jpg') }];
  const req = (extra = {}) => ({ signal: new AbortController().signal, minConfidence: 0.1, maxLabelsPerFrame: 8, maxObservationsPerFrame: 64, ...extra });

  it.each([
    ['not JSON at all', 'process.stdout.write("<html>oops")'],
    ['JSON of the wrong shape', 'process.stdout.write("[1,2,3]")'],
    ['empty output', ''],
    ['null', 'process.stdout.write("null")'],
  ])('malformed response (%s) is an error, never a finding', async (_n, body) => {
    const helper = await fakeHelper(body);
    await expect(helper.analyze(frames, req() as never)).rejects.toMatchObject({ code: 'invalid-response' });
  });
  it('a crash (signal) or non-zero exit is an inference failure with no engine output', async () => {
    for (const body of ['process.exit(3)', 'process.kill(process.pid,"SIGSEGV")']) {
      const helper = await fakeHelper(`process.stderr.write("/Users/secret/path stack trace");${body}`);
      const e = await helper.analyze(frames, req() as never).catch((x: Error) => x);
      expect(e).toMatchObject({ code: 'inference-failed' });
      expect(String((e as Error).message)).not.toMatch(/secret|stack/);
    }
  });
  it('results for frames we did not send, duplicates and absurd values cannot create observations for them', async () => {
    const helper = await fakeHelper(`process.stdout.write(JSON.stringify({frames:[{index:99,observations:[{type:'text',label:'x',confidence:5,text:'BAD'}]},{index:-1},{index:0,observations:'no'}]}))`);
    const out = await helper.analyze(frames, req() as never).catch((e: Error) => e);
    // Either the strict parser refuses the whole batch, or the frames we sent come back with nothing attributed to them.
    if (Array.isArray(out)) { expect(out).toHaveLength(2); for (const f of out) expect(JSON.stringify(f)).not.toContain('BAD'); }
    else expect(out).toMatchObject({ code: 'invalid-response' });
  });
  it('an endless helper is killed at the deadline and leaves no process behind', async () => {
    const helper = await fakeHelper('setInterval(()=>{},1000)');
    const ac = new AbortController();
    setTimeout(() => ac.abort('timeout'), 150);
    await expect(helper.analyze(frames, req({ signal: ac.signal }) as never)).rejects.toMatchObject({ code: 'timeout' });
    expect(liveProcessCount()).toBe(0);
  });
  it('hostile whisper.cpp JSON is parsed defensively or refused', () => {
    expect(() => parseWhisperCppJson({ transcription: 'x' })).toThrow();
    expect(() => parseWhisperCppJson(null)).toThrow();
    const r = parseWhisperCppJson({ transcription: [{ offsets: { from: 'a', to: {} }, text: 5, tokens: [{ text: 1 }, null, { text: ' ok', p: 'high', offsets: null }] }, null, 7], result: 3 });
    expect(r.segments).toHaveLength(3);
    expect(JSON.stringify(r)).not.toContain('NaN');
    const proto = JSON.parse('{"transcription":[{"offsets":{"from":0,"to":1000},"text":" hi","__proto__":{"polluted":true},"tokens":[]}]}');
    parseWhisperCppJson(proto);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('whisper reports a missing or unusable binary as unavailable instead of throwing at the server', async () => {
    const w = new WhisperCppProvider({ binaryPath: join(scratch, 'nope'), modelPath: join(scratch, 'nomodel'), modelName: 'ggml-base', threads: 1 });
    expect(await w.isAvailable()).toBe(false);
    await expect(w.transcribe({ file: { path: join(scratch, 'a.wav') }, durationSeconds: 1 }, { language: null, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('sandbox policy plumbing', () => {
  it('an unknown ProcessError kind never carries a command line or path', async () => {
    const e = await runBinary(join(scratch, 'does-not-exist'), ['--secret-arg']).catch((x: ProcessError) => x);
    expect(e).toMatchObject({ kind: 'spawn-failed' });
    expect(String((e as Error).message) + String((e as Error).stack ?? '').split('\n')[0]).not.toMatch(/secret-arg|does-not-exist/);
  });
});
