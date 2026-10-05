import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaResponse } from '@/domain/api/contract';
import type { MediaExtraction } from '@/domain/extraction/extraction';
import { hasFfmpeg, startTestApp, upload, waitForExtraction, type TestApp } from './helpers';

const hashOf = async (app: TestApp, id: string, artifact: string) => {
  const h = createHash('sha256');
  for await (const c of app.storage.readArtifact(id, artifact)) h.update(c);
  return h.digest('hex');
};

/** Removes values that legitimately differ between runs (ids, wall-clock times, timings). Everything else must match. */
const normalize = (e: MediaExtraction) => ({ ...e, mediaId: '<id>', createdAt: '<t>', startedAt: '<t>', completedAt: '<t>', metrics: e.metrics && { stageMs: '<t>', durationMs: '<t>', toolProcesses: e.metrics.toolProcesses, outputBytes: e.metrics.outputBytes } });

describe.skipIf(!hasFfmpeg)('determinism: same media + same configuration ⇒ same extraction', () => {
  let dir: string;
  let app: TestApp;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sw-det-'));
    await writeFile(join(dir, 's.srt'), '1\n00:00:01,000 --> 00:00:03,500\nfirst <i>cue</i>\n\n2\n00:00:12,250 --> 00:00:14,000\nsecond\ncue\n');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000', '-i', join(dir, 's.srt'),
      '-t', '25', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-b:v', '200k', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-c:s', 'srt', '-map', '0', '-map', '1', '-map', '2', '-map', '3',
      '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=deu', '-metadata:s:s:0', 'language=eng', join(dir, 'det.mkv')], { stdio: 'ignore' });
    app = await startTestApp({ extraction: { limits: { frame: { intervalSeconds: 5, maxFrames: 300, maxWidth: 320, maxHeight: 320 } } } });
  });
  afterAll(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  const runOnce = async (): Promise<{ manifest: MediaExtraction; hashes: string[] }> => {
    const bytes = new Uint8Array(await readFile(join(dir, 'det.mkv')));
    const { media } = (await (await upload(app, bytes, 'det.mkv', 'video/x-matroska')).json()) as MediaResponse;
    const manifest = await waitForExtraction(app, media.asset.id);
    const artifacts = [...manifest.audio.flatMap((a) => (a.artifact ? [a.artifact] : [])), ...(manifest.frames?.frames.map((f) => f.artifact) ?? [])];
    return { manifest, hashes: await Promise.all(artifacts.map((a) => hashOf(app, media.asset.id, a))) };
  };

  it('produces identical timestamps, frame counts, cue timings, audio metadata and normalised manifests, and byte-identical assets', async () => {
    const a = await runOnce();
    const b = await runOnce();
    expect(a.manifest.mediaId).not.toBe(b.manifest.mediaId); // two genuinely separate runs

    // The specific properties called out in the requirements.
    expect(a.manifest.frames!.frames.map((f) => f.timestampSeconds)).toEqual(b.manifest.frames!.frames.map((f) => f.timestampSeconds));
    expect(a.manifest.frames!.frames.length).toBe(b.manifest.frames!.frames.length);
    // ~25 s at one frame per 5 s (the container reports slightly more than 25 s because the audio runs longer, hence 5 or 6).
    expect([5, 6]).toContain(a.manifest.frames!.frames.length);
    expect(a.manifest.frames!.effectiveIntervalSeconds).toBeGreaterThan(4);
    expect(a.manifest.frames!.effectiveIntervalSeconds).toBeLessThanOrEqual(5);
    expect(a.manifest.subtitles.map((t) => t.cues.map((c) => [c.startSeconds, c.endSeconds, c.text]))).toEqual(b.manifest.subtitles.map((t) => t.cues.map((c) => [c.startSeconds, c.endSeconds, c.text])));
    expect(a.manifest.audio.map((x) => ({ ...x }))).toEqual(b.manifest.audio.map((x) => ({ ...x })));

    // The whole manifest, after normalising ids and wall-clock values.
    expect(normalize(a.manifest)).toEqual(normalize(b.manifest));

    // Stronger: the extracted files themselves are byte-identical.
    expect(a.hashes.length).toBe(2 + a.manifest.frames!.frames.length);
    expect(a.hashes).toEqual(b.hashes);
  });
});
